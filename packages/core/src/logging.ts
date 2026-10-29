/**
 * Logging setup. LogTape is the logging backend for the whole tool: a
 * JSON-lines file sink (one JSON object per line) plus a console sink.
 *
 * The core package depends on LogTape directly so the CLI and the future MCP
 * server share one configuration and one file format.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  configureSync,
  disposeSync,
  getConsoleSink,
  getLogger,
  jsonLinesFormatter,
  withFilter,
  type LogLevel,
  type Logger,
} from '@logtape/logtape'
import { getFileSink } from '@logtape/file'
import type { PipelineLogger } from './pipeline/types.js'

/** A console object that writes every method to stderr. */
const stderrConsole: Console = {
  log: (...args: unknown[]) => console.error(...args),
  info: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.error(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.error(...args),
  trace: (...args: unknown[]) => console.error(...args),
} as Console

export const DEFAULT_LOG_PATH = join(homedir(), '.linkinbox', 'log.jsonl')

export interface LoggingOptions {
  /** Path of the JSON-lines log file. Defaults to ~/.linkinbox/log.jsonl. */
  path?: string
  /** Lowest level for the console sink. Defaults to 'info'. */
  consoleLevel?: LogLevel
  /** Lowest level for the file sink. Defaults to 'debug'. */
  fileLevel?: LogLevel
  /** Disable the console sink (tests, quiet mode). */
  console?: boolean
}

export interface LoggingSetup {
  logger: Logger
  path: string
  /** Flush and close the sinks. Call before process exit. */
  dispose(): void
}

let current: LoggingSetup | null = null

/**
 * Resolve the log file path: explicit option, then `LINKINBOX_LOG_FILE`, then
 * the default location.
 */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['LINKINBOX_LOG_FILE']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return DEFAULT_LOG_PATH
}

/**
 * Configure LogTape: a JSON-lines file sink plus a console sink. Idempotent:
 * calling it twice replaces the previous configuration (and disposes it).
 */
export function setupLogging(options: LoggingOptions = {}): LoggingSetup {
  const path = options.path ?? resolveLogPath()
  mkdirSync(dirname(path), { recursive: true })

  const fileLevel = options.fileLevel ?? 'debug'
  const consoleLevel = options.consoleLevel ?? 'info'

  const sinks: Record<string, (record: never) => void> = {
    file: withFilter(
      getFileSink(path, { formatter: jsonLinesFormatter }),
      fileLevel,
    ),
  }
  if (options.console !== false) {
    // Everything goes to stderr so command output (json, tables) stays clean
    // on stdout.
    sinks['console'] = withFilter(getConsoleSink({ console: stderrConsole }), consoleLevel)
  }
  const sinkIds = Object.keys(sinks)

  configureSync({
    reset: true,
    sinks: sinks as never,
    loggers: [
      {
        category: ['logtape', 'meta'],
        sinks: sinkIds as never,
        lowestLevel: 'error',
      },
      {
        category: 'linkinbox',
        sinks: sinkIds as never,
        lowestLevel: fileLevel,
      },
    ],
  })

  const setup: LoggingSetup = {
    logger: getLogger(['linkinbox']),
    path,
    dispose() {
      disposeSync()
      if (current === setup) current = null
    },
  }
  current = setup
  return setup
}

/** Dispose the active logging configuration, if any. */
export function disposeLogging(): void {
  if (current) {
    current.dispose()
    return
  }
  disposeSync()
}

/** Adapt a LogTape logger to the small PipelineLogger shape. */
export function toPipelineLogger(logger: Logger): PipelineLogger {
  return {
    debug: (message, properties) => logger.debug(message, properties ?? {}),
    info: (message, properties) => logger.info(message, properties ?? {}),
    warn: (message, properties) => logger.warn(message, properties ?? {}),
    error: (message, properties) => logger.error(message, properties ?? {}),
  }
}

/** A pipeline logger that writes to a LogTape category. */
export function pipelineLogger(category: string): PipelineLogger {
  const logger = getLogger(['linkinbox', category])
  return toPipelineLogger(logger)
}
