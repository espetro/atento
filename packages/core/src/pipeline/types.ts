import type { Enrichment, Link } from '../types.js'

/**
 * Injected enrichment entry point. The `enrich` package (built separately)
 * implements this against an OpenAI-compatible endpoint. The pipeline never
 * talks to a model directly: it calls the injected function and records what
 * comes back.
 */
export type EnrichFn = (
  link: Link,
) => Promise<
  | {
      ok: true
      enrichment: Enrichment
      tokensIn: number
      tokensOut: number
      costUsd?: number
      modelId: string
    }
  | { ok: false; error: string }
>

/**
 * Injected extraction entry point. The CLI adapts the extractors router to
 * this shape; tests inject a mock.
 *
 * `extractor` is an optional extra used only to tag per-extractor error
 * metrics. A function matching the plain shape stays assignable to this type.
 */
export type ExtractFn = (url: string) => Promise<{
  markdown: string
  title?: string
  needsBrowser?: boolean
  extractor?: string
  /**
   * True when the host refused the session (login wall, captcha, unusual
   * activity). The stage opens the host's circuit breaker and defers the
   * rest of that host's batch.
   */
  blocked?: boolean
  /** Short reason for the block, e.g. "login_wall". */
  blockReason?: string
}>

/** Stage names, used as the `stage` column in `runs` and `metrics`. */
export const STAGES = {
  ingest: 'ingest',
  extract: 'extract',
  enrich: 'enrich',
} as const

export type Stage = (typeof STAGES)[keyof typeof STAGES]

/** Per-stage outcome for a single link. */
export interface LinkOutcome {
  linkId: number
  url: string
  ok: boolean
  /** Present when the step failed or was deferred. */
  error?: string
  /** True when the link was skipped (already processed, limit reached). */
  skipped?: boolean
  /** True when extraction could not run locally and needs a browser. */
  needsBrowser?: boolean
  /** Extracted character count (extract stage). */
  chars?: number
  /** Model identity (enrich stage). */
  modelId?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

/** Result of running one pipeline stage. */
export interface StageResult {
  stage: Stage
  /** The `runs` row id for this execution. */
  runId: number
  inputCount: number
  okCount: number
  errorCount: number
  skippedCount: number
  durationMs: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  outcomes: LinkOutcome[]
  /** Non-fatal warnings (importer warnings, malformed input, ...). */
  warnings: string[]
}

/** Options shared by every stage. */
export interface StageOptions {
  /** Injected logger; defaults to a no-op logger. */
  logger?: PipelineLogger
  /** Clock, injectable for tests. */
  now?: () => Date
}

/**
 * Minimal logger shape used by the pipeline. Deliberately tiny so the core
 * package does not depend on LogTape: the CLI wires a LogTape-backed logger
 * in, tests can use a collecting logger.
 */
export interface PipelineLogger {
  debug(message: string, properties?: Record<string, unknown>): void
  info(message: string, properties?: Record<string, unknown>): void
  warn(message: string, properties?: Record<string, unknown>): void
  error(message: string, properties?: Record<string, unknown>): void
}

/** A logger that drops everything. Default for pipeline stages. */
export const noopLogger: PipelineLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** Collects log records in memory. Used by tests. */
export interface CollectingLogger extends PipelineLogger {
  readonly records: { level: string; message: string; properties?: Record<string, unknown> }[]
}

export function createCollectingLogger(): CollectingLogger {
  const records: { level: string; message: string; properties?: Record<string, unknown> }[] = []
  const push = (level: string) => (message: string, properties?: Record<string, unknown>) => {
    records.push({ level, message, properties })
  }
  return {
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}
