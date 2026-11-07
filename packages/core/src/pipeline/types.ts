import type { Enrichment, Link } from '../types.js'
import type { MediaFn, MediaReport } from '../media.js'

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
  /** Site metadata (og:type, twitter:card, author, ...), JSON-safe scalars. */
  meta?: Record<string, unknown>
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
  /**
   * The HTTP status when the page is permanently gone (404 or 410). For a
   * flagged, profile-backed or login-gated host a 404 means "private page",
   * not "gone".
   */
  gone?: number
  /** The final URL after redirects, for login-wall detection. */
  finalUrl?: string
  /** The HTTP status of the final response. */
  status?: number
  /** The raw HTML, for login-wall detection. */
  html?: string
  /**
   * Why the extraction produced no content, when it is known: the fetch
   * failed, the command timed out. The stage maps it to a park reason
   * (a timeout, a bot block, a JS shell).
   */
  error?: string
}>

/** Stage names, used as the `stage` column in `runs` and `metrics`. */
export const STAGES = {
  ingest: 'ingest',
  extract: 'extract',
  enrich: 'enrich',
  media: 'media',
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
  /** True when the media stage ran for this link (extract stage). */
  media?: boolean
  /** Model identity (enrich stage). */
  modelId?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

/** The run currently holding a stage's single-writer lock. */
export interface BusyRun {
  /** The runs-row id of the holding run (also StageResult.runId when busy). */
  runId: number
  stage: string
  pid: number | null
  startedAt: Date
  heartbeatAt: Date | null
}

/** Result of running one pipeline stage. */
export interface StageResult {
  stage: Stage
  /** The `runs` row id for this execution (the holder's id when busy). */
  runId: number
  /**
   * Set when another run holds this stage's single-writer lock: the stage
   * did no work and every count is zero. Callers surface this as busy,
   * never as a failure.
   */
  busy?: BusyRun
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
