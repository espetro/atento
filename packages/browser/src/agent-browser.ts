/**
 * agent-browser adapter: the CLI browser engine behind the core ports.
 *
 * PageReader: `agent-browser --profile <dir> open <url>` then `read`
 * (agent-readable text, so contentFormat is "markdown") then `close`.
 * SessionLogin: a headed `open`, wait for the user, `close` — the same
 * flow the pre-M1 login command ran.
 *
 * Everything is injectable (exec, spawn, env) so tests never touch a real
 * browser or process.
 */
import { existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import type {
  BrowserCaps,
  BrowserHealth,
  LoginResult,
  PageNavigation,
  PageReaderPort,
  PageSession,
  ProfileRef,
  SessionLoginPort,
  SessionLoginUi,
} from '@atento/core'
import { browserProfileDir } from '@atento/core'
import type { ExecLike } from '@atento/extractors'

export interface AgentBrowserAdapterOptions {
  /** The adapter instance id (config key). */
  id: string
  /** agent-browser binary; default env ATENTO_AGENT_BROWSER then "agent-browser". */
  command?: string
  /** Chromium binary passed as --executable-path. */
  executablePath?: string
  /** Base profiles dir, used when open() gets no ProfileRef. */
  profilesDir?: string
  /** Subprocess runner for the read path (tests). */
  exec?: ExecLike
  /** Environment the command name resolves from. */
  env?: Record<string, string | undefined>
  /**
   * Process spawner for the headed login flow (tests). Receives the full
   * argv after the binary name; resolves the exit code.
   */
  spawn?: (command: string, args: string[]) => Promise<number>
}

const CAPS: BrowserCaps = {
  stealth: false,
  headless: true,
  persistentProfile: true,
}

function defaultExec(
  file: string,
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options?.timeoutMs,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as { code?: number }).code as number)
            : error
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

function defaultSpawn(command: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', () => resolve(-1))
    child.on('exit', (c) => resolve(c ?? 0))
  })
}

export interface AgentBrowserAdapter {
  reader: PageReaderPort
  login: SessionLoginPort
  /** Health check for `atento browsers`: binary resolves and answers --version. */
  health(): Promise<BrowserHealth>
}

export function createAgentBrowserAdapter(
  options: AgentBrowserAdapterOptions,
): AgentBrowserAdapter {
  const env = options.env ?? process.env
  const command =
    options.command ?? env['ATENTO_AGENT_BROWSER'] ?? 'agent-browser'
  const exec = options.exec ?? defaultExec
  const run = options.spawn ?? defaultSpawn
  const profilesDir = options.profilesDir ?? defaultProfilesDir()

  const baseArgs = (profileDir: string): string[] => {
    const args = ['--profile', profileDir]
    if (options.executablePath) args.push('--executable-path', options.executablePath)
    return args
  }

  const profilePath = (host: string, profile?: ProfileRef): string =>
    profile?.path ?? browserProfileDir(profilesDir, host, options.id)

  const reader: PageReaderPort = {
    id: options.id,
    caps: CAPS,
    contentFormat: 'markdown',
    async open({ host, profile }): Promise<PageSession> {
      const dir = profilePath(host, profile)
      const base = baseArgs(dir)
      return {
        async goto(url: string): Promise<PageNavigation> {
          const opened = await exec(command, [...base, 'open', url], { timeoutMs: 120_000 })
          if (opened.code !== 0) {
            throw new Error(
              `agent-browser open failed (exit ${opened.code}): ${opened.stderr.slice(0, 200)}`,
            )
          }
          return { finalUrl: url }
        },
        async html(): Promise<string> {
          const result = await exec(command, [...base, 'read'], { timeoutMs: 120_000 })
          if (result.code !== 0) {
            throw new Error(
              `agent-browser read failed (exit ${result.code}): ${result.stderr.slice(0, 200)}`,
            )
          }
          return result.stdout
        },
        async scroll(pixels: number): Promise<void> {
          await exec(command, [...base, 'scroll', 'down', String(pixels)], {
            timeoutMs: 10_000,
          }).catch(() => undefined)
        },
        async close(): Promise<void> {
          await exec(command, [...base, 'close'], { timeoutMs: 15_000 }).catch(() => undefined)
        },
      }
    },
  }

  const login: SessionLoginPort = {
    id: options.id,
    async login(
      host: string,
      profile: ProfileRef,
      ui: SessionLoginUi,
      url?: string,
    ): Promise<LoginResult> {
      const dir = profile.path
      const target = url ?? `https://${host}/`
      // `open` returns once the page loads while the browser keeps running,
      // so the login is finished by the user, not by this process exiting.
      const code = await run(command, [...baseArgs(dir), '--headed', 'open', target])
      if (code !== 0) return { ok: false, detail: `browser exited with code ${code}` }
      await ui.waitForUser(
        `Log in to ${host} in the browser window, then press Enter here to save the session... `,
      )
      // Closing flushes the session into the profile directory.
      await run(command, [...baseArgs(dir), 'close'])
      return { ok: true }
    },
    async verify(_host: string, profile: ProfileRef): Promise<boolean> {
      return existsSync(profile.path)
    },
  }

  return {
    reader,
    login,
    async health(): Promise<BrowserHealth> {
      const result = await exec(command, ['--version'], { timeoutMs: 10_000 })
      if (result.code !== 0) {
        return {
          id: options.id,
          kind: 'agent-browser',
          ok: false,
          detail: `could not run ${command} --version: ${result.stderr.slice(0, 120)}`,
        }
      }
      const version = result.stdout.trim().split('\n')[0] ?? ''
      return { id: options.id, kind: 'agent-browser', ok: true, detail: version || 'ok' }
    },
  }
}

function defaultProfilesDir(): string {
  const home = process.env['HOME'] ?? ''
  return `${home}/.atento/profiles`
}
