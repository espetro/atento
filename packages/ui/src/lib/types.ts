export type LinkStatus = 'inbox' | 'scheduled' | 'archived' | 'discarded'
export type Priority = 'low' | 'normal' | 'high'
export type LinkAction = 'read_now' | 'schedule' | 'archive' | 'discard'

/** The twelve pipeline states, in the FSM order. */
export const PIPELINE_STATES = [
  'created',
  'extracting',
  'extracted',
  'needs_browser',
  'deferred',
  'enriching',
  'inbox',
  'scheduled',
  'archived',
  'discarded',
  'errored',
  'deleted',
] as const

export type PipelineState = (typeof PIPELINE_STATES)[number]

/** The seven pipeline collections (packages/core/src/collections.ts). */
export const COLLECTION_NAMES = [
  'enriched',
  'pending',
  'needs_login',
  'blocked',
  'errored',
  'review',
  'triaged',
] as const

export type CollectionName = (typeof COLLECTION_NAMES)[number]

/** Preview pane tabs. */
export const PREVIEW_TABS = ['reader', 'metadata', 'snapshot', 'live'] as const
export type PreviewTab = (typeof PREVIEW_TABS)[number]

/** Raw FSM state payload riding along on rows/details (camelCase wire). */
export interface StateData {
  reason?: string
  reasonClass?: string
  error?: string
  stage?: string
  retryable?: boolean
  nextAttemptAt?: string
  frameable?: boolean
  [key: string]: unknown
}

export interface LinkSummary {
  id: number
  title: string
  url: string
  category: string
  priority: Priority
  why_it_matters: string
  read_minutes: number
  status: LinkStatus
  expires_at: string | null
  expiry_reason: string | null
  action: LinkAction
  /** The FSM state of the link. */
  state?: PipelineState | string
  /** Why the link sits in that state (park reason, error, ...). */
  reason?: string | null
  /** The host of the url. */
  host?: string
  /** When the link is retried, for deferred links. */
  next_attempt_at?: string | null
  /** When the row last changed. */
  updated_at?: string
  /** Raw FSM state payload (park detail, frameable flag on detail). */
  stateData?: StateData | null
  note?: string | null
  tags?: string[] | null
}

export interface LinkDetail extends LinkSummary {
  extracted_content: string
  enrichment: Record<string, unknown>
  confidence: number
  note: string | null
  tags: string[] | null
  source: string
  needsBrowser: boolean
  createdAt?: string
  updatedAt?: string
  extractedAt?: string | null
}

export interface LinksResponse {
  items: LinkSummary[]
  total: number
}

export interface CollectionsSummary {
  total: number
  collections: Partial<Record<CollectionName, number>>
  needsLoginHosts: { host: string; count: number }[]
}

export interface PipelineOverviewResponse {
  byState: Record<string, number>
  byParkReason: Record<string, number>
  byHost: {
    host: string
    total: number
    byState?: Record<string, number>
    byParkReason?: Record<string, number>
  }[]
}

// ---- ingest ---------------------------------------------------------------

export type IngestJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'busy'

export interface IngestJobSummary {
  jobId: string
  accepted: number
  duplicates: number
  rejected: number
  status: IngestJobStatus
  warnings: string[]
  /** Present on the 409 busy response: the run holding the ingest lock. */
  busy?: { runId?: number | string; pid?: number } | null
}

export interface IngestJob {
  jobId: string
  source: string
  status: 'pending' | 'running' | 'done' | 'failed'
  total: number
  done: number
  cursor: number
  runId: number | null
  error: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

// ---- run -------------------------------------------------------------------

export interface RunStageSummary {
  batches?: number
  input?: number
  ok?: number
  errors?: number
  deferred?: number
  needsBrowser?: number
  hitCap?: boolean
  /** Set when another run held this stage's lock; the stage did no work (exit 3). */
  busy?: { runId?: number | string; pid?: number } | null
  [key: string]: unknown
}

export interface RunResult {
  runId: string
  cursorBefore: number
  cursorAfter: number
  summary: {
    ingest: { jobs: IngestJobSummary[] }
    extract: RunStageSummary
    enrich: RunStageSummary
    swept: number
    needsAction: boolean
    collections: {
      collections?: Partial<Record<CollectionName, number>>
      needsLoginHosts?: { host: string; count: number }[]
      [key: string]: unknown
    }
  }
}

export interface RunJournalRow {
  id: number
  stage: string
  status: string | null
  pid: number | null
  startedAt: string
  heartbeatAt: string | null
  finishedAt: string | null
  inputCount: number
  okCount: number
  errorCount: number
  durationMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
}

// ---- settings ---------------------------------------------------------------

export interface BrowserAdapterInfo {
  id: string
  kind: string
  roles: string[]
  caps: {
    stealth: boolean
    headless: boolean
    persistentProfile: boolean
  } | null
  defaultFor: { reader: boolean; login: boolean }
  inEscalate: boolean
  health: { ok: boolean; detail: string }
}

export interface BrowserAdaptersResponse {
  adapters: BrowserAdapterInfo[]
  hostMappings: Record<string, string>
  reader: string
  login: string
  escalate: string[]
}

export interface ConfigInfo {
  dir: string
  configPath: string
  sources: string[]
  capture: {
    tokenEnv: string
    tokenConfigured: boolean
    allowedOrigins: string[]
  }
  server: {
    tokenEnv: string
    tokenConfigured: boolean
  }
  bind: {
    hostname: string
    port: number
    tokenRequired: boolean
  }
}

export interface PairCode {
  code: string
  expiresAt: string
}

export interface PairTokens {
  captureToken: string | null
  serverToken: string | null
}

// ---- metrics ----------------------------------------------------------------

export interface StageMetrics {
  stage: string
  runs: number
  ok: number
  errors: number
  p50_ms: number
  p95_ms: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

export interface DailyMetrics {
  date: string
  tokens: number
  cost_usd: number
}

export interface MetricsResponse {
  stages: StageMetrics[]
  daily: DailyMetrics[]
}
