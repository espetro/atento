/**
 * Logging setup. A JSON-lines file sink (one JSON object per line) plus a
 * console sink, both written with direct node:fs / console calls.
 *
 * No logging dependency on purpose: the previous LogTape backend pulled
 * `@logtape/file`, which passes `fs.writeSync` and friends as function values
 * and held a WeakRef-based logger tree, neither of which scriptc compiles
 * natively. This module only uses calls scriptc lowers (appendFileSync,
 * mkdirSync, JSON.stringify, Date), so it compiles to a native binary and
 * runs unchanged under Node.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import type { PipelineLogger } from './pipeline/types.js'

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 }

export const DEFAULT_LOG_PATH = join(homedir(), '.atento', 'log.jsonl')

export interface LoggingOptions {
  /** Path of the JSON-lines log file. Defaults to ~/.atento/log.jsonl. */
  path?: string
  /** Lowest level for the console sink. Defaults to 'info'. */
  consoleLevel?: LogLevel
  /** Lowest level for the file sink. Defaults to 'debug'. */
  fileLevel?: LogLevel
  /** Disable the console sink (tests, quiet mode). */
  console?: boolean
}

/** Category-scoped logger. Structurally a PipelineLogger. */
export interface Logger extends PipelineLogger {
  readonly category: string
}

export interface LoggingSetup {
  logger: Logger
  path: string
  /** Flush and close the sinks. Call before process exit. */
  dispose(): void
}

interface Sinks {
  path: string
  fileRank: number
  consoleRank: number
  console: boolean
}

let sinks: Sinks | null = null
let current: LoggingSetup | null = null

/**
 * Resolve the log file path: explicit option, then `ATENTO_LOG_FILE`, then
 * the default location.
 */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['ATENTO_LOG_FILE']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return DEFAULT_LOG_PATH
}

/** LogTape-style `{key}` placeholders filled from the properties. */
function render(message: string, properties: Record<string, unknown> | undefined): string {
  if (properties === undefined) return message
  return message.replace(/\{([A-Za-z0-9_.]+)\}/g, (whole: string, key: string) => {
    const value = properties[key]
    if (value === undefined) return whole
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

function emit(category: string, level: LogLevel, message: string, properties?: Record<string, unknown>): void {
  const s = sinks
  if (s === null) return
  const rank = LEVEL_RANK[level]
  if (rank >= s.fileRank) {
    const line = JSON.stringify({
      '@timestamp': new Date().toISOString(),
      level: level === 'warning' ? 'WARN' : level.toUpperCase(),
      message: render(message, properties),
      logger: category,
      properties: properties ?? {},
    })
    try {
      appendFileSync(s.path, line + '\n')
    } catch {
      // A broken log file must never take the command down.
    }
  }
  if (s.console && rank >= s.consoleRank) {
    // Everything goes to stderr so command output (json, tables) stays clean
    // on stdout.
    console.error(`${new Date().toISOString()} [${level.toUpperCase()}] ${category}: ${render(message, properties)}`)
  }
}

function makeLogger(category: string): Logger {
  return {
    category,
    debug: (message, properties) => emit(category, 'debug', message, properties),
    info: (message, properties) => emit(category, 'info', message, properties),
    warn: (message, properties) => emit(category, 'warning', message, properties),
    error: (message, properties) => emit(category, 'error', message, properties),
  }
}

/**
 * Configure the file and console sinks. Idempotent: calling it twice replaces
 * the previous configuration.
 */
export function setupLogging(options: LoggingOptions = {}): LoggingSetup {
  const path = options.path ?? resolveLogPath()
  mkdirSync(dirname(path), { recursive: true })
  sinks = {
    path,
    fileRank: LEVEL_RANK[options.fileLevel ?? 'debug'],
    consoleRank: LEVEL_RANK[options.consoleLevel ?? 'info'],
    console: options.console !== false,
  }
  const setup: LoggingSetup = {
    logger: makeLogger('atento'),
    path,
    dispose() {
      if (current === setup) {
        sinks = null
        current = null
      }
    },
  }
  current = setup
  return setup
}

/** Dispose the active logging configuration, if any. */
export function disposeLogging(): void {
  sinks = null
  current = null
}

/** Kept for API compatibility: a Logger already is a PipelineLogger. */
export function toPipelineLogger(logger: Logger): PipelineLogger {
  return logger
}

/** A pipeline logger for a category under `atento`. */
export function pipelineLogger(category: string): PipelineLogger {
  return makeLogger(`atento.${category}`)
}
