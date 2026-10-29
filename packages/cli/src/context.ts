/**
 * Shared CLI context: config, store, logger. Every command resolves its
 * dependencies from here so the command bodies stay thin.
 */
import { openStore, type SqliteStore } from '@linkinbox/db'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  disposeLogging,
  pipelineLogger,
  setupLogging,
  type PipelineLogger,
} from '@linkinbox/core'
import { loadConfig, type AppConfig } from './config.js'

export interface CliContext {
  config: AppConfig
  store: SqliteStore
  logger: PipelineLogger
  /** Flush logs and close the store. */
  close(): Promise<void>
}

export interface ContextOptions {
  env?: NodeJS.ProcessEnv
  /** Override the store (tests). */
  store?: SqliteStore
  /** Disable the console log sink (tests). */
  quiet?: boolean
  /** Override the log file path (tests). */
  logPath?: string
}

/** Build the context: config, open store, configure logging. */
export async function createContext(options: ContextOptions = {}): Promise<CliContext> {
  const env = options.env ?? process.env
  const config = loadConfig(env)
  mkdirSync(dirname(config.dbPath), { recursive: true })
  const store = options.store ?? (await openStore({ path: config.dbPath }))
  const logging = setupLogging({
    path: options.logPath ?? env['LINKINBOX_LOG_FILE'],
    console: options.quiet === true ? false : true,
  })

  return {
    config,
    store,
    logger: pipelineLogger('cli'),
    async close() {
      await store.close()
      disposeLogging()
    },
  }
}

/** Open only the store (no logging). Used by read-only commands. */
export async function openStoreFor(config: AppConfig): Promise<SqliteStore> {
  return openStore({ path: config.dbPath })
}
