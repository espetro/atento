/**
 * Shared CLI context: config, app, store, logger. Every command resolves its
 * dependencies from here so the command bodies stay thin.
 *
 * The context is built on `createLinkinbox` from @linkinbox/app: the store
 * opening, the config and the adapter wiring all live in the composition
 * root; the CLI only adds its logging sinks on top.
 */
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openStore, type SqliteStore } from '@linkinbox/db'
import {
  createLinkinbox,
  disposeLogging,
  loadConfig,
  pipelineLogger,
  setupLogging,
  type AppConfig,
  type AsrFn,
  type EnrichFn,
  type ExtractFn,
  type Linkinbox,
  type MediaFn,
  type PipelineLogger,
} from '@linkinbox/app'

export interface CliContext {
  config: AppConfig
  /** The application layer: every operation goes through it. */
  app: Linkinbox
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
  /** Override the config (tests). */
  config?: AppConfig
  /** Override the extract fn (tests). */
  extractFn?: ExtractFn
  /** Override the enrich fn (tests). */
  enrichFn?: EnrichFn
  /** Override the media stage fn (tests). */
  mediaFn?: MediaFn
  /** Override the ASR provider for the media stage (tests). */
  asr?: AsrFn
}

/** Build the context: config, app (store + adapters), logging sinks. */
export async function createContext(options: ContextOptions = {}): Promise<CliContext> {
  const env = options.env ?? process.env
  const config = options.config ?? loadConfig(env)
  const logger = pipelineLogger('cli')
  const app = await createLinkinbox(config, {
    env,
    ...(options.store !== undefined ? { store: options.store } : {}),
    logger,
    ...(options.extractFn !== undefined ? { extractFn: options.extractFn } : {}),
    ...(options.enrichFn !== undefined ? { enrichFn: options.enrichFn } : {}),
    ...(options.mediaFn !== undefined ? { mediaFn: options.mediaFn } : {}),
    ...(options.asr !== undefined ? { asr: options.asr } : {}),
  })
  setupLogging({
    path: options.logPath ?? env['LINKINBOX_LOG_FILE'],
    console: options.quiet === true ? false : true,
  })

  return {
    config,
    app,
    store: app.store as SqliteStore,
    logger,
    async close() {
      await app.close()
      disposeLogging()
    },
  }
}

/** Open only the store (no logging). Used by read-only commands. */
export async function openStoreFor(config: AppConfig): Promise<SqliteStore> {
  return openStore({ path: config.dbPath })
}
