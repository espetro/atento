// Domain types for the linkinbox pipeline. Pure, no IO.

/** What an importer produces, before normalization. */
export interface RawLink {
  url: string
  title?: string
  addedAt?: Date
  tags?: string[]
  note?: string
  /** Importer identity, e.g. "markdown", "safari-reading-list". */
  source: string
}

/** Enrichment output, produced by exactly one structured-output call per link. */
export interface Enrichment {
  category: string
  priority: 'low' | 'normal' | 'high'
  why_it_matters: string
  read_minutes: number
  action: 'read_now' | 'schedule' | 'archive' | 'discard'
  expires_at: string | null
  expiry_reason: string | null
  confidence: number
}

export const PRIORITIES = ['low', 'normal', 'high'] as const
export const ACTIONS = ['read_now', 'schedule', 'archive', 'discard'] as const

/** Lifecycle status of a link. */
export type Status = 'inbox' | 'scheduled' | 'archived' | 'discarded'

/** A normalized, stored link. */
export interface Link {
  id: number
  urlHash: string
  url: string
  title: string | null
  source: string
  addedAt: Date | null
  note: string | null
  tags: string[] | null
  extractedContent: string | null
  extractedAt: Date | null
  enrichment: Enrichment | null
  /** ISO timestamp when the link goes stale. Deterministic input to sweeps. */
  expiresAt: Date | null
  expiryReason: string | null
  status: Status
  /** FSM discriminant for the link's current state. */
  state: string
  /** FSM variant payload (parsed shape varies per state). */
  stateData: Record<string, unknown> | null
  /** Flattened enrichment columns (mirrors the enrichment json blob). */
  category: string | null
  priority: Enrichment['priority'] | null
  action: Enrichment['action'] | null
  confidence: number | null
  readMinutes: number | null
  needsBrowser: boolean
  /**
   * True when the content came from a client-side capture (the user's own
   * logged-in session), not from the headless pipeline. Captured content
   * outranks anything the pipeline fetched itself.
   */
  captured: boolean
  /** When the content was captured (client-side captures only). */
  capturedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** One pipeline stage execution. */
export interface Run {
  id: number
  stage: string
  startedAt: Date
  finishedAt: Date | null
  inputCount: number
  okCount: number
  errorCount: number
  durationMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
}

/** A single metric sample. */
export interface Metric {
  timestamp: Date
  stage: string
  key: string
  value: number
  tags?: Record<string, string> | null
}

/** agent-browser profile path for a host. */
export interface Profile {
  host: string
  path: string
  createdAt: Date
  updatedAt: Date
}

export type ProfileInput = Pick<Profile, 'host' | 'path'> &
  Partial<Pick<Profile, 'createdAt' | 'updatedAt'>>

/** Data needed to insert or update a link, keyed on urlHash. */
export type LinkInput = Omit<
  Link,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'category'
  | 'priority'
  | 'action'
  | 'confidence'
  | 'readMinutes'
  | 'extractedContent'
  | 'extractedAt'
  | 'enrichment'
  | 'expiresAt'
  | 'expiryReason'
  | 'state'
  | 'stateData'
  | 'captured'
  | 'capturedAt'
> & {
  id?: number
  createdAt?: Date
  updatedAt?: Date
  state?: string
  stateData?: Record<string, unknown> | null
  /** Optional: set by the extract stage. */
  extractedContent?: string | null
  extractedAt?: Date | null
  /** Optional: set by the enrich stage. */
  enrichment?: Enrichment | null
  /** Optional: set by the enrich stage (from enrichment.expires_at). */
  expiresAt?: Date | null
  expiryReason?: string | null
  /** Optional flattened enrichment columns; usually derived from `enrichment`. */
  category?: string | null
  priority?: Enrichment['priority'] | null
  action?: Enrichment['action'] | null
  confidence?: number | null
  readMinutes?: number | null
  /** Client-side capture marker: content came from the user's own session. */
  captured?: boolean
  /** When the capture happened (client-side captures only). */
  capturedAt?: Date | null
}
