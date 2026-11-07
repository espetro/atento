/**
 * Lifecycle state: the pidfile under the linkinbox config dir
 * (<configDir>/harness.pid, LINKINBOX_HOME-aware via configDir). The file
 * is JSON so `status` can report the port and start time, not just liveness.
 *
 * Pid-reuse safety: `stop` never signals a pid it cannot identify as the
 * harness. Before SIGTERM it runs `ps -p <pid> -o command=` (injectable) and
 * requires the command line to look like linkinbox-harness — a recycled pid
 * belonging to an unrelated process makes stop refuse instead of killing a
 * stranger. `status` stays a cheap liveness probe; `verifyHarnessPid` is
 * exported for callers that want the stronger check.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { configDir } from '@linkinbox/app'
import { writeFileAtomicSync } from './atomic.js'

const execFileAsync = promisify(execFile)

export interface PidInfo {
  pid: number
  /** ISO timestamp of when `start` wrote the file. */
  startedAt: string
  /** Bound port, when known. */
  port?: number
  /** Base URL of the running service, when known. */
  url?: string
  /**
   * The harness's own argv tail (script + args), recorded at start for
   * identity cross-checks. Optional for pidfiles written by older versions.
   */
  command?: string
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
    if (typeof raw['command'] === 'string') info.command = raw['command']
    return info
  } catch {
    return null
  }
}

export function writePidFile(path: string, info: PidInfo): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomicSync(path, JSON.stringify(info, null, 2) + '\n')
}

export function removePidFile(path: string): void {
  rmSync(path, { force: true })
}

export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => unknown

/**
 * Liveness probe: signal 0 checks existence + permission to signal without
 * delivering anything. EPERM means the process exists but is owned by
 * another user — still "alive" for our purposes.
 */
export function isPidAlive(pid: number, kill: KillFn = process.kill): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// Process identity (pid-reuse guard)
// ---------------------------------------------------------------------------

/** exec returning stdout — the shape `ps` needs (notify's ExecFn discards it). */
export type PsExecFn = (file: string, args: string[]) => Promise<{ stdout?: string }>

export const defaultPsExec: PsExecFn = async (file, args) => {
  const res = (await execFileAsync(file, args)) as { stdout: string; stderr: string }
  return { stdout: res.stdout }
}

/**
 * Does this `ps -o command=` line look like the linkinbox harness? Matches
 * the bin name (`linkinbox-harness`, e.g. a pnpm/global shim) or a
 * `bin.js` living under a `harness` directory inside a `linkinbox` tree
 * (the workspace layout `apps/harness/dist/bin.js`). Deliberately strict:
 * an unverifiable pid is treated as foreign — refusing to signal is the
 * safe direction.
 */
export function isHarnessCommand(command: string): boolean {
  const cmd = command.toLowerCase()
  if (cmd.includes('linkinbox-harness')) return true
  return (
    cmd.includes('linkinbox') &&
    cmd.includes('harness') &&
    /(^|[\s/\\])bin\.js(\s|$)/.test(cmd)
  )
}

/**
 * Verify that `pid` is really the harness before anyone signals it.
 * Returns false on ps failure or a foreign command line — fail closed.
 */
export async function verifyHarnessPid(
  info: Pick<PidInfo, 'pid' | 'command'>,
  exec: PsExecFn = defaultPsExec,
  kill: KillFn = process.kill,
): Promise<boolean> {
  if (!isPidAlive(info.pid, kill)) return false
  let stdout: string
  try {
    const res = await exec('ps', ['-p', String(info.pid), '-o', 'command='])
    stdout = res.stdout ?? ''
  } catch {
    return false
  }
  if (!isHarnessCommand(stdout)) return false
  // Cross-check the recorded argv tail when the pidfile carries one: the
  // script basename must appear in the live command line.
  if (info.command !== undefined) {
    const script = info.command.split(/\s+/)[0] ?? ''
    const base = script.split(/[\\/]/).pop()?.toLowerCase()
    if (base !== undefined && base !== '' && !stdout.toLowerCase().includes(base)) {
      return false
    }
  }
  return true
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

/**
 * Liveness probe only — does NOT verify process identity. A recycled pid
 * can still report running; use verifyHarnessPid for the strong check.
 */
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
  /** Injectable `ps` exec for the identity check (tests). */
  exec?: PsExecFn
  /** Skip the identity check (tests only — never from the CLI). */
  skipIdentityCheck?: boolean
}

export interface StopResult {
  /** True when a live, verified process was signalled and is now gone. */
  stopped: boolean
  pid?: number
  /** The pidfile was removed (always true when we got this far cleanly). */
  removedPidFile: boolean
  /** Needed SIGKILL after the graceful window. */
  killed?: boolean
  /**
   * The pid is alive but could not be verified as the harness (pid reuse
   * or unverifiable command line). Nothing was signalled; the pidfile is
   * kept so a later stop can retry.
   */
  refused?: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

/**
 * Stop the harness: verify the pidfile's process really is the harness
 * (pid-reuse guard), SIGTERM it, wait for exit, escalate to SIGKILL after
 * the timeout, then remove the pidfile. A missing or stale pidfile is not
 * an error — it just reports nothing was running.
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

  // Pid-reuse guard: only signal a pid we can prove is the harness.
  if (options.skipIdentityCheck !== true) {
    const verified = await verifyHarnessPid(info, options.exec ?? defaultPsExec, kill)
    if (!verified) {
      return { stopped: false, removedPidFile: false, pid: info.pid, refused: true }
    }
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
