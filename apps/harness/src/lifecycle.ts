/**
 * Lifecycle state: the pidfile under the linkinbox config dir
 * (<configDir>/harness.pid, LINKINBOX_HOME-aware via configDir). The file
 * is JSON so `status` can report the port and start time, not just liveness.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configDir } from '@linkinbox/app'

export interface PidInfo {
  pid: number
  /** ISO timestamp of when `start` wrote the file. */
  startedAt: string
  /** Bound port, when known. */
  port?: number
  /** Base URL of the running service, when known. */
  url?: string
}

export function harnessPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'harness.pid')
}

export function readPidFile(path: string): PidInfo | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof raw['pid'] !== 'number' || !Number.isInteger(raw['pid'])) return null
    const info: PidInfo = {
      pid: raw['pid'],
      startedAt: typeof raw['startedAt'] === 'string' ? raw['startedAt'] : '',
    }
    if (typeof raw['port'] === 'number') info.port = raw['port']
    if (typeof raw['url'] === 'string') info.url = raw['url']
    return info
  } catch {
    return null
  }
}

export function writePidFile(path: string, info: PidInfo): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(info, null, 2) + '\n')
}

export function removePidFile(path: string): void {
  rmSync(path, { force: true })
}

/**
 * Liveness probe: signal 0 checks existence + permission to signal without
 * delivering anything. EPERM means the process exists but is owned by
 * another user — still "alive" for our purposes.
 */
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => unknown

export function isPidAlive(pid: number, kill: KillFn = process.kill): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface HarnessStatus {
  running: boolean
  pid?: number
  startedAt?: string
  port?: number
  url?: string
  /** True when a pidfile exists but its process is gone. */
  stale?: boolean
}

export function harnessStatus(
  env: NodeJS.ProcessEnv = process.env,
  path: string = harnessPidPath(env),
): HarnessStatus {
  const info = readPidFile(path)
  if (info === null) return { running: false }
  if (!isPidAlive(info.pid)) {
    return { running: false, stale: true, pid: info.pid }
  }
  return {
    running: true,
    pid: info.pid,
    startedAt: info.startedAt,
    ...(info.port !== undefined ? { port: info.port } : {}),
    ...(info.url !== undefined ? { url: info.url } : {}),
  }
}

export interface StopOptions {
  env?: NodeJS.ProcessEnv
  /** Pidfile path override (tests). */
  path?: string
  /** SIGTERM → SIGKILL escalation window. Default 10s. */
  timeoutMs?: number
  /** Poll interval while waiting for exit. Default 100ms. */
  pollMs?: number
  /** Injectable for tests. */
  kill?: KillFn
  sleep?: (ms: number) => Promise<void>
}

export interface StopResult {
  /** True when a live process was signalled and is now gone. */
  stopped: boolean
  pid?: number
  /** The pidfile was removed (always true when we got this far cleanly). */
  removedPidFile: boolean
  /** Needed SIGKILL after the graceful window. */
  killed?: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

/**
 * Stop the harness: SIGTERM the pidfile's process, wait for exit, escalate
 * to SIGKILL after the timeout, then remove the pidfile. A missing or stale
 * pidfile is not an error — it just reports nothing was running.
 */
export async function stopHarness(options: StopOptions = {}): Promise<StopResult> {
  const env = options.env ?? process.env
  const path = options.path ?? harnessPidPath(env)
  const kill = options.kill ?? (((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)) as KillFn)
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? 10_000
  const pollMs = options.pollMs ?? 100

  const info = readPidFile(path)
  if (info === null) return { stopped: false, removedPidFile: false }
  if (!isPidAlive(info.pid, kill)) {
    removePidFile(path)
    return { stopped: false, removedPidFile: true, pid: info.pid }
  }

  kill(info.pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (isPidAlive(info.pid, kill)) {
    if (Date.now() >= deadline) {
      kill(info.pid, 'SIGKILL')
      // Give the kernel a moment to reap; a killed pid can linger as zombie.
      const killDeadline = Date.now() + 2000
      while (isPidAlive(info.pid, kill) && Date.now() < killDeadline) {
        await sleep(pollMs)
      }
      removePidFile(path)
      return { stopped: true, removedPidFile: true, pid: info.pid, killed: true }
    }
    await sleep(pollMs)
  }
  removePidFile(path)
  return { stopped: true, removedPidFile: true, pid: info.pid }
}
