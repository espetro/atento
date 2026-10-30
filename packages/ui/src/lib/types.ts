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
  /** The FSM state of the link, when the row carries one. */
  state?: PipelineState
  /** Why the link sits in that state, when the state records a reason. */
  reason?: string | null
  /** The host of the url. */
  host?: string
  /** When the link is retried, for deferred links. */
  next_attempt_at?: string | null
  /** When the row last changed. */
  updated_at?: string
}

export interface LinkDetail extends LinkSummary {
  extracted_content: string
  enrichment: Record<string, unknown>
  confidence: number
}

export interface LinksResponse {
  items: LinkSummary[]
  total: number
}

/** The pipeline overview: the state histogram plus the busiest hosts. */
export interface PipelineOverviewResponse {
  byState: Record<PipelineState, number>
  byHost: {
    host: string
    total: number
    byState: Record<PipelineState, number>
  }[]
}

export interface SweepGroup {
  category: string
  links: LinkSummary[]
}

export interface SweepResponse {
  groups: SweepGroup[]
}

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

export interface TriageRequest {
  ids: number[]
  action: LinkAction
}

export interface TriageResponse {
  updated: number
}
