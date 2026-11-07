/**
 * The browsers command: lists the configured adapters with roles, caps,
 * defaults, escalate membership and a health line. Health probes are real
 * but pointed at dead endpoints/missing binaries so nothing launches a
 * browser; the table and the --json shape are what is asserted.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { parseBrowserConfig, type AppConfig } from '@linkinbox/core'
import { capture, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runBrowsers } from '../src/commands/browsers.js'

async function contextFor(db: TempDb, browserToml: string): Promise<CliContext> {
  const config = {
    dbPath: db.path,
    ttl: { default_days: 30, by_category: {}, archive_after_days: 90, delete_after_days: 365 },
    profilesDir: join(db.dir, 'profiles'),
    dir: db.dir,
    browser: parseBrowserConfig(browserToml),
  } as unknown as AppConfig
  return createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    config,
  })
}

describe('browsers command', () => {
  it('prints the adapter table with health', async () => {
    const db = await tempDb()
    const prevExit = process.exitCode
    try {
      const ctx = await contextFor(
        db,
        `
[browser]
reader = "headless"
login = "user-session"
escalate = ["stealth"]

[browser.adapters.headless]
kind = "agent-browser"
command = "definitely-not-a-real-binary-lb"
[browser.adapters.stealth]
kind = "patchright"
[browser.adapters.user-session]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:1"

[browser.hosts]
"x.com" = "user-session"
`,
      )
      const out = await capture(() => runBrowsers(ctx, false))
      expect(out.stdout).toContain('headless')
      expect(out.stdout).toContain('agent-browser')
      expect(out.stdout).toContain('stealth')
      expect(out.stdout).toContain('user-session')
      expect(out.stdout).toContain('cdp-attach')
      // The dead binary and the refused endpoint report FAIL.
      expect(out.stdout).toContain('FAIL')
    } finally {
      process.exitCode = prevExit
      await db.cleanup()
    }
  })

  it('prints --json with host mappings and role defaults', async () => {
    const db = await tempDb()
    const prevExit = process.exitCode
    try {
      const ctx = await contextFor(
        db,
        `
[browser]
reader = "headless"
login = "user-session"

[browser.adapters.headless]
kind = "agent-browser"
command = "definitely-not-a-real-binary-lb"
[browser.adapters.user-session]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:1"

[browser.hosts]
"x.com" = "user-session"
`,
      )
      const out = await capture(() => runBrowsers(ctx, true))
      const parsed = JSON.parse(out.stdout) as {
        adapters: { id: string; kind: string; health: string }[]
        hostMappings: Record<string, string>
        reader: string
        login: string
      }
      expect(parsed.reader).toBe('headless')
      expect(parsed.login).toBe('user-session')
      expect(parsed.hostMappings['x.com']).toBe('user-session')
      expect(parsed.adapters.map((a) => a.id).sort()).toEqual(['headless', 'user-session'])
      expect(parsed.adapters.every((a) => a.health === 'FAIL' || a.health === 'ok')).toBe(true)
    } finally {
      process.exitCode = prevExit
      await db.cleanup()
    }
  })
})
