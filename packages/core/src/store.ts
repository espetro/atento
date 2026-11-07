import { createHash } from 'node:crypto'
import type {
  RawLink,
  Link,
  LinkInput,
  Enrichment,
  Status,
  Run,
  RunJournalStatus,
  Metric,
  Profile,
  ProfileInput,
} from './types.js'
import type { LinkEvent, LinkState, LinkStateName } from './fsm/index.js'
import type { HostState } from './resilience/types.js'
import type { MediaReport } from './media.js'

/**
 * Repository layer. Hides the storage engine (drizzle/sqlite today, maybe pg
 * tomorrow) behind a plain interface. Every pipeline stage is a pure async
 * function over this interface.
 */
export interface Store {
  // links
  upsertLink(link: LinkInput): Promise<Link>
  getLink(id: number): Promise<Link | null>
  getLinkByUrlHash(urlHash: string): Promise<Link | null>
  listLinks(filter?: LinkFilter): Promise<Link[]>
  countLinks(filter?: LinkFilter): Promise<number>
  updateStatus(ids: number[], status: Status, updatedAt?: Date): Promise<number>
  deleteLinks(ids: number[]): Promise<number>
  setEnrichment(id: number, enrichment: Enrichment, updatedAt?: Date): Promise<number>
  setExpiry(
    id: number,
    expiresAt: Date | null,
    expiryReason: string | null,
    updatedAt?: Date,
  ): Promise<number>
  setExtractedContent(
    id: number,
    content: string,
    needsBrowser: boolean,
    extractedAt?: Date,
  ): Promise<number>
  /** Set the link title, if it does not have one yet. */
  updateTitle(id: number, title: string, updatedAt?: Date): Promise<number>
  /** Mark a link as captured: the `captured` flag plus the capture timestamp. */
  markCaptured(id: number, capturedAt: Date, updatedAt?: Date): Promise<number>
  /** Store the media stage report for a link. */
  setMediaReport(id: number, report: MediaReport, updatedAt?: Date): Promise<number>

  /**
   * Per-day budget counters for the media stage, shared across processes and
   * restarts. Day key format: `YYYY-MM-DD` (UTC).
   */
  getMediaBudget(
    day: string,
  ): Promise<{ total: number; byTier: Record<string, number> }>
  saveMediaBudget(
    day: string,
    budget: { total: number; byTier: Record<string, number> },
  ): Promise<void>

  /**
   * FSM: apply one event atomically with a compare-and-set on the current
   * state. All state changes go through here; nothing else writes states.
   * `expected` defaults to the state currently recorded on the link.
   */
  applyEvent(
    linkId: number,
    event: LinkEvent,
    expected?: LinkStateName,
  ): Promise<TransitionOutcome>

  /** Append-only event history for one link, oldest first. */
  getHistory(linkId: number): Promise<LinkHistoryEntry[]>

  /** Count of links per state name (state histogram). */
  countByState(): Promise<Record<LinkStateName, number>>

  /** All links currently in one of the given FSM states. */
  listByStates(states: LinkStateName[], limit?: number): Promise<Link[]>

  /** FSM state of one link (parsed and zod-validated). */
  getState(id: number): Promise<LinkState | null>

  /**
   * Rewrite the state payload of a link without changing its state. Used by
   * the host-policy sweep: a link parked in `needs_browser` keeps its state
   * but its reason changes (e.g. to `review_only`).
   */
  setStateData(id: number, data: Record<string, unknown>): Promise<number>

  /**
   * Return every leased link whose lease expired before `cutoff` to its
   * queue state. A killed process never strands a link.
   */
  reclaimExpiredLeases(cutoff: Date): Promise<number>

  /**
   * Return every leased link owned by one of `runIds` to its queue state.
   * Called right after `reclaimDeadRuns` marks crashed runs: their leases
   * come back immediately instead of waiting out the lease timeout.
   */
  reclaimLeasesForRuns(runIds: number[], at?: Date): Promise<number>

  // run journal (durable execution)

  /**
   * Single-writer lock for one stage. Atomically inserts a `runs` row with
   * `status='running'`, the OS pid and a first heartbeat — or reports the
   * run currently holding the lock. The check-and-insert is one
   * `BEGIN IMMEDIATE` transaction, so two processes can never both win.
   */
  acquireRun(
    stage: string,
    opts?: { pid?: number; now?: Date },
  ): Promise<AcquireRunResult>

  /** Refresh the heartbeat of a running journal row. */
  heartbeatRun(id: number, at?: Date): Promise<void>

  /** Every journal row still marked `running`. */
  listRunningRuns(): Promise<RunJournalEntry[]>

  /**
   * Mark `running` journal rows `crashed` when their owner is gone: the pid
   * is dead (`pidAlive` says so) or the heartbeat is older than
   * `heartbeatStaleMs`. Returns the rows it crashed. The lease reclaim for
   * those runs is `reclaimLeasesForRuns`.
   */
  reclaimDeadRuns(opts?: {
    now?: Date
    heartbeatStaleMs?: number
    pidAlive?: (pid: number) => boolean
  }): Promise<RunJournalEntry[]>

  // runs
  startRun(stage: string, inputCount: number, startedAt?: Date): Promise<Run>
  finishRun(
    id: number,
    result: {
      finishedAt?: Date
      okCount?: number
      errorCount?: number
      durationMs?: number
      tokensIn?: number | null
      tokensOut?: number | null
      costUsd?: number | null
      /** Journal: the batch size, when known only after selection. */
      inputCount?: number
      /** Journal lifecycle written with the finish: done (default) | failed. */
      status?: 'done' | 'failed'
    },
  ): Promise<void>

  // metrics
  addMetric(metric: Metric): Promise<void>
  listMetrics(filter?: MetricFilter): Promise<Metric[]>

  // browser profiles (agent-browser profile path per host)
  listProfiles(): Promise<Profile[]>
  getProfile(host: string): Promise<Profile | null>
  upsertProfile(profile: ProfileInput): Promise<Profile>
  deleteProfile(host: string): Promise<number>

  // host resilience state (limiter + breaker budget, shared across processes)
  getHostState(key: string): Promise<HostState | null>
  saveHostState(state: HostState): Promise<void>
  listHostStates(): Promise<HostState[]>

  // meta / maintenance
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
  schemaVersion(): Promise<string>
  migrate(): Promise<void>
  close(): Promise<void>
}

export interface LinkFilter {
  status?: Status
  /** When true, `status` filters on the FSM state instead of the legacy column. */
  byState?: boolean
  category?: string
  staleAsOf?: Date
  limit?: number
  offset?: number
}

export interface MetricFilter {
  stage?: string
  since?: Date
  until?: Date
  limit?: number
}

/** Result of Store.acquireRun: the new journal row, or the current holder. */
export type AcquireRunResult =
  | { ok: true; run: RunJournalEntry }
  | { ok: false; busy: RunJournalEntry }

/** The journal view of one runs row. */
export interface RunJournalEntry {
  id: number
  stage: string
  status: RunJournalStatus
  pid: number | null
  startedAt: Date
  heartbeatAt: Date | null
  finishedAt: Date | null
}

export type { RunJournalStatus }

/** Suggested canonical importer identities. Not enforced here. */
export const SOURCES = {
  markdown: 'markdown',
  json: 'json',
  urlList: 'url-list',
  safariReadingList: 'safari-reading-list',
} as const satisfies Record<string, string>

export type {
  RawLink,
  Link,
  Enrichment,
  Status,
  Run,
  Metric,
  Profile,
  ProfileInput,
  MediaReport,
}

/** Outcome of Store.applyEvent: the new state, or a typed error. */
export type TransitionOutcome =
  | { ok: true; state: LinkState; from: LinkStateName }
  | { ok: false; error: Illegal | Stale }

/** The transition is not legal from the link's current state. */
export interface Illegal {
  code: 'ILLEGAL_TRANSITION'
  from: LinkStateName
  event: string
  message: string
}

/** Another writer changed the state between read and write (lost CAS race). */
export interface Stale {
  code: 'STALE_STATE'
  from: LinkStateName
  expected?: LinkStateName
  message: string
}

/** One row of the append-only link_events table. */
export interface LinkHistoryEntry {
  id: number
  linkId: number
  fromState: string
  toState: string
  event: string
  data: Record<string, unknown> | null
  at: Date
}

/** Build a URL hash (sha256 hex of the normalized url). Kept for importers. */
export function urlHashOf(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}
