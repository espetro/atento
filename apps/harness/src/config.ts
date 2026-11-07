/**
 * harness.toml — the harness's own optional config, kept separate from
 * config.toml (which the app layer owns). Lives in the linkinbox config
 * dir next to config.toml, so LINKINBOX_HOME / LINKINBOX_CONFIG_DIR apply.
 *
 *   schedule = "0 6 * * *"     # cron expression; each tick calls app.run
 *   on_ingest = true           # debounced run after ingest jobs complete
 *   ingest_poll_ms = 1000      # how often ingest_jobs is scanned
 *   ingest_debounce_ms = 2000  # quiet window before an ingest-triggered run
 *   notify = true              # native notification after each run
 *   web_dir = "/path/to/build" # override the apps/web build directory
 *
 * Missing file is fine: the harness then only serves the web UI.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { configDir, expandHome, type AppConfig } from '@linkinbox/app'

export const DEFAULT_INGEST_POLL_MS = 1000
export const DEFAULT_INGEST_DEBOUNCE_MS = 2000

export interface HarnessConfig {
  /** Cron expression for periodic `app.run` ticks (5 fields). */
  schedule?: string
  /** Run a debounced pipeline pass after ingest jobs complete. */
  onIngest: boolean
  /** How often ingest_jobs is scanned for completions. */
  ingestPollMs: number
  /** Quiet window that batches ingest completions into one run. */
  ingestDebounceMs: number
  /** Send a native notification after each run. */
  notify: boolean
  /** Absolute path of the built web UI; overrides the apps/web lookup. */
  webDir?: string
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  onIngest: false,
  ingestPollMs: DEFAULT_INGEST_POLL_MS,
  ingestDebounceMs: DEFAULT_INGEST_DEBOUNCE_MS,
  notify: true,
}

export function harnessConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'harness.toml')
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Load harness.toml. A missing file yields the defaults; a malformed file
 * or bad value types throw — the operator asked for recurrence, so failing
 * loudly beats silently never running.
 */
export function loadHarnessConfig(
  env: NodeJS.ProcessEnv = process.env,
  appConfig?: Pick<AppConfig, 'dir'>,
): HarnessConfig {
  const dir = appConfig?.dir ?? configDir(env)
  const path = join(dir, 'harness.toml')
  if (!existsSync(path)) return { ...DEFAULT_HARNESS_CONFIG }
  const toml = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>

  const out: HarnessConfig = { ...DEFAULT_HARNESS_CONFIG }
  const schedule = nonEmptyString(toml['schedule'])
  if (schedule !== undefined) out.schedule = schedule
  if (typeof toml['on_ingest'] === 'boolean') out.onIngest = toml['on_ingest']
  const poll = positiveInt(toml['ingest_poll_ms'])
  if (poll !== undefined) out.ingestPollMs = poll
  const debounce = positiveInt(toml['ingest_debounce_ms'])
  if (debounce !== undefined) out.ingestDebounceMs = debounce
  if (typeof toml['notify'] === 'boolean') out.notify = toml['notify']
  const webDir = nonEmptyString(toml['web_dir'])
  if (webDir !== undefined) out.webDir = expandHome(webDir)
  return out
}
