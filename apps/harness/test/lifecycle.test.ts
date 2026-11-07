import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  harnessPidPath,
  harnessStatus,
  isPidAlive,
  readPidFile,
  stopHarness,
  writePidFile,
} from '../src/lifecycle.js'

let dirs: string[] = []
let children: ChildProcess[] = []

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-harness-life-'))
  dirs.push(dir)
  return { env: { LINKINBOX_HOME: dir } as NodeJS.ProcessEnv, dir }
}

function pidPathFor(env: NodeJS.ProcessEnv): string {
  return harnessPidPath(env)
}

afterEach(async () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already dead
    }
  }
  children = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

describe('pidfile', () => {
  it('reports not running when no pidfile exists', () => {
    const { env } = tempEnv()
    expect(harnessStatus(env)).toEqual({ running: false })
  })

  it('writes and reads a pidfile under LINKINBOX_HOME', () => {
    const { env, dir } = tempEnv()
    const path = pidPathFor(env)
    expect(path).toBe(join(dir, '.linkinbox', 'harness.pid'))
    writePidFile(path, { pid: process.pid, startedAt: '2026-01-01T00:00:00Z', port: 4173, url: 'http://127.0.0.1:4173' })
    const info = readPidFile(path)
    expect(info?.pid).toBe(process.pid)
    expect(info?.port).toBe(4173)
    expect(info?.url).toBe('http://127.0.0.1:4173')
    expect(existsSync(path)).toBe(true)
  })

  it('status reports running for a live pid', () => {
    const { env } = tempEnv()
    const path = pidPathFor(env)
    writePidFile(path, { pid: process.pid, startedAt: '2026-01-01T00:00:00Z' })
    const status = harnessStatus(env)
    expect(status.running).toBe(true)
    expect(status.pid).toBe(process.pid)
  })

  it('status reports stale for a dead pid', () => {
    const { env } = tempEnv()
    const child = spawnSleeper()
    const pid = child.pid!
    // Wait for spawn then kill and reap.
    return new Promise<void>((resolve) => {
      child.on('spawn', () => {
        child.kill('SIGKILL')
        child.on('exit', () => {
          const path = pidPathFor(env)
          writePidFile(path, { pid, startedAt: '2026-01-01T00:00:00Z' })
          const status = harnessStatus(env)
          expect(status.running).toBe(false)
          expect(status.stale).toBe(true)
          resolve()
        })
      })
    })
  })
})

describe('isPidAlive', () => {
  it('is true for this process, false for an impossible pid', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    // pid 0 is the process group on unix — not a valid target for signal 0
    // semantics we want; use a very large pid instead.
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false)
  })
})

describe('stopHarness', () => {
  it('returns stopped:false when no pidfile exists', async () => {
    const { env } = tempEnv()
    const result = await stopHarness({ env })
    expect(result.stopped).toBe(false)
    expect(result.removedPidFile).toBe(false)
  })

  it('removes a stale pidfile without signalling', async () => {
    const { env } = tempEnv()
    const path = pidPathFor(env)
    writePidFile(path, { pid: 2 ** 22 + 999, startedAt: 'x' })
    const result = await stopHarness({ env })
    expect(result.stopped).toBe(false)
    expect(result.removedPidFile).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('SIGTERMs a live process and removes the pidfile', async () => {
    const { env } = tempEnv()
    const child = spawnSleeper()
    const pid = await new Promise<number>((resolve) =>
      child.on('spawn', () => resolve(child.pid!)),
    )
    const path = pidPathFor(env)
    writePidFile(path, { pid, startedAt: '2026-01-01T00:00:00Z' })

    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    )
    const result = await stopHarness({ env, timeoutMs: 5000, pollMs: 20 })
    expect(result.stopped).toBe(true)
    expect(result.pid).toBe(pid)
    expect(result.killed).toBeUndefined()
    expect(existsSync(path)).toBe(false)
    await exited
    expect(isPidAlive(pid)).toBe(false)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { env } = tempEnv()
    // Ignore SIGTERM so only SIGKILL can stop it; signal readiness on stdout
    // so the handler is installed before we signal.
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    children.push(child)
    const pid = child.pid!
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve())
      child.once('error', reject)
      setTimeout(() => reject(new Error('child never became ready')), 5000)
    })
    const path = pidPathFor(env)
    writePidFile(path, { pid, startedAt: '2026-01-01T00:00:00Z' })

    const result = await stopHarness({ env, timeoutMs: 300, pollMs: 20 })
    expect(result.stopped).toBe(true)
    expect(result.killed).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(isPidAlive(pid)).toBe(false)
  })
})
