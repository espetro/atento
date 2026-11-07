import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHarness,
  installPaths,
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT,
  uninstallHarness,
} from '../src/install.js'
import { createRecordingNotifier, runNotification } from '../src/notify.js'
import type { HarnessRunRecord } from '../src/runs.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-harness-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('renderLaunchdPlist', () => {
  it('produces a keep-alive launchd agent plist', () => {
    const xml = renderLaunchdPlist({
      logPath: '/tmp/lb/harness.log',
      nodePath: '/usr/local/bin/node',
      binPath: '/repo/apps/harness/dist/bin.js',
      env: { LINKINBOX_HOME: '/tmp/lbhome' },
    })
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<string>/usr/local/bin/node</string>')
    expect(xml).toContain('<string>/repo/apps/harness/dist/bin.js</string>')
    expect(xml).toContain('<string>start</string>')
    expect(xml).toContain('<string>/tmp/lb/harness.log</string>')
    expect(xml).toContain('<key>LINKINBOX_HOME</key>')
    expect(xml).toContain('<string>/tmp/lbhome</string>')
    // XML-escapes env values
    const tricky = renderLaunchdPlist({ logPath: '/tmp/x', env: { A: 'a&b<c' } })
    expect(tricky).toContain('a&amp;b&lt;c')
  })
})

describe('renderSystemdUnit', () => {
  it('produces a restart-always systemd user unit', () => {
    const unit = renderSystemdUnit({
      logPath: '/tmp/lb/harness.log',
      nodePath: '/usr/bin/node',
      binPath: '/repo/apps/harness/dist/bin.js',
    })
    expect(unit).toContain('[Unit]')
    expect(unit).toContain('[Service]')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain(`ExecStart='/usr/bin/node' '/repo/apps/harness/dist/bin.js' 'start'`)
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain(`StandardOutput=append:/tmp/lb/harness.log`)
  })

  it('escapes env values with single quotes', () => {
    const unit = renderSystemdUnit({
      logPath: '/tmp/l',
      env: { LINKINBOX_HOME: "/tmp/it's" },
    })
    expect(unit).toContain(`Environment=LINKINBOX_HOME="/tmp/it's"`)
  })
})

describe('installPaths', () => {
  it('picks launchd on darwin, systemd elsewhere', () => {
    const home = tempDir()
    const darwin = installPaths({ LINKINBOX_HOME: tempDir() }, 'darwin', home)
    expect(darwin.unitPath).toBe(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))
    const linux = installPaths({ LINKINBOX_HOME: tempDir() }, 'linux', home)
    expect(linux.unitPath).toBe(join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT))
    expect(linux.logPath).toContain('.linkinbox')
  })
})

describe('installHarness / uninstallHarness', () => {
  const neverExec = async () => {
    throw new Error('should not exec')
  }

  it('writes a launchd plist idempotently without registering', async () => {
    const home = tempDir()
    const env = { LINKINBOX_HOME: tempDir() } as NodeJS.ProcessEnv
    const first = await installHarness({ env, platform: 'darwin', homeDir: home, register: false, exec: neverExec })
    expect(first.registered).toBe(false)
    expect(first.unitPath).toBe(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))
    const content = readFileSync(first.unitPath, 'utf8')
    expect(content).toContain(LAUNCHD_LABEL)
    // Second install overwrites cleanly (idempotent).
    const second = await installHarness({ env, platform: 'darwin', homeDir: home, register: false, exec: neverExec })
    expect(second.unitPath).toBe(first.unitPath)
    expect(readFileSync(second.unitPath, 'utf8')).toBe(content)
  })

  it('writes a systemd unit and reports registration via exec', async () => {
    const home = tempDir()
    const env = { LINKINBOX_HOME: tempDir() } as NodeJS.ProcessEnv
    const calls: string[] = []
    const exec = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
    }
    const result = await installHarness({ env, platform: 'linux', homeDir: home, register: true, exec })
    expect(result.registered).toBe(true)
    expect(existsSync(result.unitPath)).toBe(true)
    expect(readFileSync(result.unitPath, 'utf8')).toContain('Restart=always')
    expect(calls.some((c) => c.startsWith('systemctl --user daemon-reload'))).toBe(true)
    expect(calls.some((c) => c.includes('enable --now linkinbox-harness'))).toBe(true)
  })

  it('survives supervisor registration failure', async () => {
    const home = tempDir()
    const env = { LINKINBOX_HOME: tempDir() } as NodeJS.ProcessEnv
    const exec = async () => {
      throw new Error('systemctl missing')
    }
    const result = await installHarness({ env, platform: 'linux', homeDir: home, register: true, exec })
    expect(result.registered).toBe(false)
    expect(result.errors[0]).toContain('systemctl missing')
    expect(existsSync(result.unitPath)).toBe(true)
  })

  it('uninstall removes the unit file', async () => {
    const home = tempDir()
    const env = { LINKINBOX_HOME: tempDir() } as NodeJS.ProcessEnv
    await installHarness({ env, platform: 'linux', homeDir: home, register: false, exec: neverExec })
    const unitPath = join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
    expect(existsSync(unitPath)).toBe(true)
    const result = await uninstallHarness({ env, platform: 'linux', homeDir: home, register: false, exec: neverExec })
    expect(result.removed).toBe(true)
    expect(existsSync(unitPath)).toBe(false)
    // Idempotent: second uninstall reports nothing removed.
    const again = await uninstallHarness({ env, platform: 'linux', homeDir: home, register: false, exec: neverExec })
    expect(again.removed).toBe(false)
  })
})

describe('runNotification', () => {
  function record(overrides: Partial<HarnessRunRecord> = {}): HarnessRunRecord {
    return {
      runId: 'run-1',
      trigger: 'cron',
      cursorBefore: 1,
      cursorAfter: 9,
      summary: {
        ingest: { jobs: [] },
        extract: { batches: 1, input: 30, ok: 30, errors: 0, deferred: 0, needsBrowser: 0, hitCap: false },
        enrich: { batches: 2, input: 23, ok: 23, errors: 0, deferred: 0, needsBrowser: 0, hitCap: false },
        swept: 0,
        needsAction: true,
        collections: {
          total: 40,
          collections: { needs_login: 4 } as HarnessRunRecord['summary']['collections']['collections'],
          needsLoginHosts: [],
        },
      },
      finishedAt: '2026-01-01T00:00:00Z',
      durationMs: 10,
      ...overrides,
    }
  }

  it('formats "N enriched, M need login" with the ui url', () => {
    const n = runNotification(record(), 'http://127.0.0.1:4173')
    expect(n.title).toBe('linkinbox run finished')
    expect(n.body).toBe('23 enriched, 4 need login — action needed')
    expect(n.url).toBe('http://127.0.0.1:4173')
  })

  it('formats failures', () => {
    const n = runNotification(record({ error: 'boom' }))
    expect(n.title).toBe('linkinbox run failed')
    expect(n.body).toBe('boom')
  })
})

describe('createNotifier', () => {
  it('uses terminal-notifier on darwin when available', async () => {
    const { createNotifier } = await import('../src/notify.js')
    const calls: [string, string[]][] = []
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args])
    }
    const notifier = createNotifier({ platform: 'darwin', exec })
    await notifier.notify({ title: 't', body: 'b', url: 'http://x' })
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('terminal-notifier')
    expect(calls[0]![1]).toContain('-open')
    expect(calls[0]![1]).toContain('http://x')
  })

  it('falls back to osascript when terminal-notifier is missing', async () => {
    const { createNotifier } = await import('../src/notify.js')
    const calls: [string, string[]][] = []
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args])
      if (file === 'terminal-notifier') throw new Error('ENOENT')
    }
    const notifier = createNotifier({ platform: 'darwin', exec })
    await notifier.notify({ title: 'my "title"', body: 'b', url: 'http://ui' })
    expect(calls.map((c) => c[0])).toEqual(['terminal-notifier', 'osascript'])
    expect(calls[1]![1][1]).toContain('my \\"title\\"')
    expect(calls[1]![1][1]).toContain('b — http://ui')
  })

  it('uses notify-send on linux with the url in the body', async () => {
    const { createNotifier } = await import('../src/notify.js')
    const calls: [string, string[]][] = []
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args])
    }
    const notifier = createNotifier({ platform: 'linux', exec })
    await notifier.notify({ title: 't', body: 'b', url: 'http://x' })
    expect(calls[0]![0]).toBe('notify-send')
    expect(calls[0]![1][1]).toBe('b — http://x')
  })

  it('degrades silently when every notifier fails', async () => {
    const { createNotifier } = await import('../src/notify.js')
    const exec = async () => {
      throw new Error('no notifier')
    }
    const notifier = createNotifier({ platform: 'linux', exec })
    await expect(notifier.notify({ title: 't', body: 'b' })).resolves.toBeUndefined()
  })

  it('is a no-op on unsupported platforms', async () => {
    const { createNotifier } = await import('../src/notify.js')
    const exec = async () => {
      throw new Error('must not be called')
    }
    const notifier = createNotifier({ platform: 'win32', exec })
    await expect(notifier.notify({ title: 't', body: 'b' })).resolves.toBeUndefined()
  })
})

describe('createRecordingNotifier', () => {
  it('records requests', async () => {
    const n = createRecordingNotifier()
    await n.notify({ title: 'a', body: 'b' })
    expect(n.requests).toEqual([{ title: 'a', body: 'b' }])
  })
})
