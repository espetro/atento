import { createHash } from 'node:crypto'
import type {
  RawLink,
  Link,
  LinkInput,
  Enrichment,
  Status,
  Run,
  RunJournalStatus,
  IngestJob,
  IngestJobStatus,
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
   * Atomically patch link columns (one UPDATE). Use this — or the `patch`
   * argument of `applyEvent` — instead of sequential set* calls whenever the
   * writes belong together: a crash can then never leave a link half
   * updated (content stored but still leased, markers set but content not).
   */
  patchLink(id: number, patch: LinkPatch, updatedAt?: Date): Promise<number>

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
   *
   * `patch` writes link columns in the SAME transaction as the transition
   * and the history row — the durable-execution rule that a result and its
   * FSM event commit together or not at all. When the event is illegal or
   * the CAS is lost, the patch is discarded with it.
   */
  applyEvent(
    linkId: number,
    event: LinkEvent,
    expected?: LinkStateName,
    patch?: LinkPatch,
  ): Promise<TransitionOutcome>

  /** Append-only event history for one link, oldest first. */
  getHistory(linkId: number): Promise<LinkHistoryEntry[]>

  /**
   * High-water mark of `link_events.id` — the monotonic cursor the
   * collections delta reads hand out. 0 when the table is empty.
   */
  linkEventCursor(): Promise<number>

  /**
   * Delta read for collections: every link with at least one `link_events`
   * row whose id is greater than `since`, deduplicated and ordered by link
   * id. Links that never transitioned (and so have no events) do not
   * appear — the cursor is the event log, by design.
   */
  listChangedLinks(since: number, limit?: number): Promise<Link[]>

  /**
   * Delta read of the event log itself: every `link_events` row whose id is
   * greater than `since`, oldest first. This is the resumable cursor stream
   * behind `GET /api/events` (SSE `Last-Event-ID`).
   */
  listLinkEvents(since: number, limit?: number): Promise<LinkHistoryEntry[]>

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
   * One `runs` row by id: the journal entry plus the stage counters
   * (input/ok/error counts, duration, tokens, cost). Null when unknown.
   */
  getRun(id: number): Promise<Run | null>

  /**
   * `runs` rows ordered by id. `since` keeps rows whose `startedAt` OR
   * `finishedAt` is newer than the instant — the poll shape live event
   * streams use to spot run starts and finishes.
   */
  listRuns(opts?: {
    since?: Date
    limit?: number
    /** Keyset pagination: only rows with id greater than this. */
    afterId?: number
  }): Promise<Run[]>

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

  // ingest jobs (durable bulk ingest)

  /** Insert a new ingest job row (status 'pending'). */
  createIngestJob(job: NewIngestJob): Promise<IngestJob>

  getIngestJob(id: string): Promise<IngestJob | null>

  /** Patch job fields; `updatedAt` defaults to now. */
  updateIngestJob(
    id: string,
    patch: {
      status?: IngestJobStatus
      total?: number
      done?: number
      cursor?: number
      spoolPath?: string | null
      runId?: number | null
      error?: string | null
      finishedAt?: Date | null
      updatedAt?: Date
    },
  ): Promise<void>

  /**
   * Jobs in the given statuses, oldest first.
   * `finishedAfter` keeps only jobs whose effective finish stamp
   * (`finished_at`, falling back to `updated_at` — failed jobs never set
   * `finished_at`) is at or after the given time. Lets pollers watermark
   * instead of scanning the whole terminal-job history.
   */
  listIngestJobs(filter?: {
    status?: IngestJobStatus | IngestJobStatus[]
    limit?: number
    finishedAfter?: Date
  }): Promise<IngestJob[]>

  /**
   * Commit one chunk of spooled input atomically: every link upsert AND the
   * job's cursor/done advance happen in one transaction, so a crash can
   * never leave links written past the recorded cursor. Per-item failures
   * (bad url, store error) are captured in the result, not thrown — the
   * chunk still commits and the cursor still advances.
   */
  commitIngestChunk(
    jobId: string,
    raws: RawLink[],
    opts?: { now?: Date },
  ): Promise<IngestChunkCommit>

  // runs
  /**
   * Legacy metrics row — NOT a journal lock. Inserts with a non-'running'
   * status so it never holds a stage lock, never heartbeats and never gets
   * reclaimed as crashed. Stage work must use `acquireRun` +
   * `heartbeatRun`; `finishRun` still closes this row out.
   */
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
  /**
   * Free-text search text. SqliteStore answers it with the links_fts FTS5
   * index (title, url, note, tags, enrichment summary); other stores fall
   * back to a substring match over the same fields. Raw user input — the
   * store sanitizes it into a safe query.
   */
  match?: string
  /**
   * 'relevance' orders `match` hits by rank (bm25 on sqlite). Ignored
   * without `match`; the default order stays created_at DESC, id DESC.
   */
  sort?: 'relevance'
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

/** Fields needed to create an ingest_jobs row. */
export interface NewIngestJob {
  id: string
  source: string
  /** Absolute path of the job's spool directory. */
  spoolPath?: string | null
  /** Known input size up front (pre-parsed payloads). */
  total?: number
}

/** Per-link outcome inside one committed ingest chunk. */
export interface IngestItemResult {
  linkId: number
  url: string
  ok: boolean
  /** The url_hash was already known: upsert was a no-op downstream. */
  duplicate: boolean
  error?: string
}

/** Result of one atomic ingest chunk commit. */
export interface IngestChunkCommit {
  /** New cursor: old cursor + raws.length (every item is consumed). */
  cursor: number
  /** New done count: old done + raws.length. */
  done: number
  inserted: number
  updated: number
  items: IngestItemResult[]
}

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

/**
 * Column writes that ride along with a store write in one transaction.
 * `undefined` leaves the column alone; `null` clears it.
 *
 * When `enrichment` is present the denormalized columns (category,
 * priority, action, confidence, read_minutes) derive from it exactly like
 * `setEnrichment`, and `expiresAt`/`expiryReason` default to the
 * enrichment's own `expires_at`/`expiry_reason` — pass them explicitly to
 * override (a TTL-derived expiry, a park reason, a cleared expiry).
 */
export interface LinkPatch {
  title?: string | null
  /** User note shown in the UI list/preview. */
  note?: string | null
  /** User tags (JSON array column). */
  tags?: string[] | null
  extractedContent?: string | null
  extractedAt?: Date | null
  needsBrowser?: boolean
  enrichment?: Enrichment | null
  expiresAt?: Date | null
  expiryReason?: string | null
  captured?: boolean
  capturedAt?: Date | null
  mediaReport?: MediaReport | null
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
