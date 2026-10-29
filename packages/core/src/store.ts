import { createHash } from 'node:crypto'
import type {
  RawLink,
  Link,
  LinkInput,
  Enrichment,
  Status,
  Run,
  Metric,
  Profile,
  ProfileInput,
} from './types.js'
import type { LinkEvent, LinkState, LinkStateName } from './fsm/index.js'

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
   * Return every leased link whose lease expired before `cutoff` to its
   * queue state. A killed process never strands a link.
   */
  reclaimExpiredLeases(cutoff: Date): Promise<number>

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

/** Suggested canonical importer identities. Not enforced here. */
export const SOURCES = {
  markdown: 'markdown',
  json: 'json',
  urlList: 'url-list',
  safariReadingList: 'safari-reading-list',
} as const satisfies Record<string, string>

export type { RawLink, Link, Enrichment, Status, Run, Metric, Profile, ProfileInput }

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
