/**
 * Service registration: `install` writes a launchd agent (macOS) or a
 * systemd user unit (Linux) that keeps `linkinbox-harness start` alive, and
 * `uninstall` removes it. Registration is best-effort — the unit files are
 * the source of truth and are (re)written idempotently every install.
 *
 * The spawned command is always `node <this package>/dist/bin.js start`,
 * resolved from import.meta so it works from a pnpm workspace, a global
 * install or a bundled binary layout.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir } from '@linkinbox/app'
import { defaultExec, type ExecFn } from './notify.js'

export const LAUNCHD_LABEL = 'com.linkinbox.harness'
export const SYSTEMD_UNIT = 'linkinbox-harness.service'

export interface InstallPaths {
  /** Absolute path of the agent/unit file to write. */
  unitPath: string
  /** Log file the supervisor appends stdout/stderr to. */
  logPath: string
}

/** Where the unit file and log live for the current platform. */
export function installPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): InstallPaths {
  const home = homeDir
  const dir = configDir(env)
  if (platform === 'darwin') {
    return {
      unitPath: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
      logPath: join(dir, 'harness.log'),
    }
  }
  return {
    unitPath: join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT),
    logPath: join(dir, 'harness.log'),
  }
}

/** Absolute path of this package's bin entry (dist/bin.js next to us). */
export function harnessBinPath(): string {
  // src/install.ts compiles to dist/install.js; bin.js sits beside it.
  return fileURLToPath(new URL('./bin.js', import.meta.url))
}

export interface UnitRenderOptions {
  /** Command argv after the node binary — defaults to `start`. */
  args?: string[]
  nodePath?: string
  binPath?: string
  logPath: string
  /** Extra environment for the service (e.g. LINKINBOX_HOME). */
  env?: Record<string, string>
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Render the launchd plist XML. Pure — tests assert on the content. */
export function renderLaunchdPlist(opts: UnitRenderOptions): string {
  const node = opts.nodePath ?? process.execPath
  const bin = opts.binPath ?? harnessBinPath()
  const args = opts.args ?? ['start']
  const argv = [node, bin, ...args]
  const env = opts.env ?? {}
  const envXml = Object.entries(env)
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`,
    )
    .join('\n')
  const argvXml = argv.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argvXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logPath)}</string>${envXml === '' ? '' : `
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>`}
</dict>
</plist>
`
}

/** Render the systemd user unit. Pure — tests assert on the content. */
export function renderSystemdUnit(opts: UnitRenderOptions): string {
  const node = opts.nodePath ?? process.execPath
  const bin = opts.binPath ?? harnessBinPath()
  const args = (opts.args ?? ['start']).map(shellQuote).join(' ')
  const env = opts.env ?? {}
  // systemd Environment= uses double-quote quoting (not shell quoting);
  // escape backslashes and double quotes inside the value.
  const envLines = Object.entries(env)
    .map(
      ([k, v]) =>
        `Environment=${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    )
    .join('\n')
  return `[Unit]
Description=linkinbox harness (linkinbox-harness start)
After=network-online.target

[Service]
Type=simple
ExecStart=${shellQuote(node)} ${shellQuote(bin)} ${args}
Restart=always
RestartSec=5
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}${envLines === '' ? '' : `
${envLines}`}

[Install]
WantedBy=default.target
`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** LINKINBOX_* env the service should inherit explicitly. */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('LINKINBOX_') && typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

export interface InstallOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Override $HOME for unit-path resolution (tests). */
  homeDir?: string
  /** Write files but skip supervisor registration (tests, --no-register). */
  register?: boolean
  exec?: ExecFn
}

export interface InstallResult {
  unitPath: string
  registered: boolean
  /** Supervisor commands that failed (registration is best-effort). */
  errors: string[]
}

/**
 * Idempotent install: (re)write the unit file, then best-effort register it
 * with the platform supervisor. Safe to run repeatedly.
 */
export async function installHarness(options: InstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const register = options.register ?? true
  const exec = options.exec ?? defaultExec
  const { unitPath, logPath } = installPaths(env, platform, options.homeDir)
  const render = platform === 'darwin' ? renderLaunchdPlist : renderSystemdUnit
  const content = render({ logPath, env: serviceEnv(env) })

  mkdirSync(dirname(unitPath), { recursive: true })
  writeFileSync(unitPath, content)

  const errors: string[] = []
  let registered = false
  if (register) {
    try {
      if (platform === 'darwin') {
        // Modern launchd: bootstrap into the user gui domain. Fall back to
        // the legacy load syntax when bootstrap rejects an already-loaded
        // label — install stays idempotent either way.
        const uid = typeof process.getuid === 'function' ? process.getuid() : 501
        try {
          await exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`])
        } catch {
          // not loaded — fine
        }
        await exec('launchctl', ['bootstrap', `gui/${uid}`, unitPath])
        registered = true
      } else {
        await exec('systemctl', ['--user', 'daemon-reload'])
        await exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT.replace(/\.service$/, '')])
        registered = true
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { unitPath, registered, errors }
}

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Override $HOME for unit-path resolution (tests). */
  homeDir?: string
  register?: boolean
  exec?: ExecFn
}

export interface UninstallResult {
  unitPath: string
  removed: boolean
  errors: string[]
}

/** Remove the unit file and best-effort unregister from the supervisor. */
export async function uninstallHarness(options: UninstallOptions = {}): Promise<UninstallResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const register = options.register ?? true
  const exec = options.exec ?? defaultExec
  const { unitPath } = installPaths(env, platform, options.homeDir)

  const errors: string[] = []
  if (register) {
    try {
      if (platform === 'darwin') {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 501
        await exec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`])
      } else {
        await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT.replace(/\.service$/, '')])
        await exec('systemctl', ['--user', 'daemon-reload'])
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  const removed = existsSync(unitPath)
  rmSync(unitPath, { force: true })
  return { unitPath, removed, errors }
}
