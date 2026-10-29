import type { LinkEvent, LinkEventName } from './events.js'
import type { LinkState, LinkStateName } from './states.js'

/**
 * The transition table: the single source of truth for allowed state
 * changes. Every pair listed here is legal; every other (state, event) pair
 * is rejected with IllegalTransition.
 *
 * The table type requires an entry for every state, so adding a state to the
 * union without handling it here fails typecheck.
 */

export type Handler<S extends LinkStateName, E extends LinkEventName> = (
  state: Extract<LinkState, { state: S }>,
  event: Extract<LinkEvent, { type: E }>,
  at: Date,
) => LinkState

type AnyHandler = (state: LinkState, event: LinkEvent, at: Date) => LinkState

/** Every state must appear; every event of a state must be listed to be legal. */
type StateTable = {
  [S in LinkStateName]: Partial<{ [E in LinkEventName]: Handler<S, E> }>
}

const TABLE: StateTable = {
  // created: the queue head. Stages claim work atomically.
  created: {
    EXTRACT_STARTED: (_s, e, at) => ({
      state: 'extracting',
      startedAt: at.toISOString(),
      attempt: e.attempt ?? 1,
    }),
    ENRICH_STARTED: (_s, e, at) => ({
      state: 'enriching',
      startedAt: at.toISOString(),
      attempt: e.attempt ?? 1,
    }),
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // extracting (leased): extraction finishes, gives up, defers, or dies.
  extracting: {
    EXTRACTED: (_s, e) => ({ state: 'extracted', chars: e.chars }),
    NEEDS_BROWSER: (_s, e) => ({ state: 'needs_browser', host: e.host ?? '' }),
    EXTRACT_FAILED: (_s, e) => ({
      state: 'errored',
      stage: 'extract',
      error: e.error,
      attempts: e.attempts ?? 1,
      retryable: e.retryable ?? true,
    }),
    DEFER: (_s, e) => ({
      state: 'deferred',
      stage: e.stage,
      nextAttemptAt: e.nextAttemptAt,
      attempts: e.attempts,
      reason: e.reason,
    }),
    LEASE_EXPIRED: () => ({ state: 'created' }),
  },

  // extracted: content present, awaiting enrichment.
  extracted: {
    ENRICH_STARTED: (_s, e, at) => ({
      state: 'enriching',
      startedAt: at.toISOString(),
      attempt: e.attempt ?? 1,
    }),
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // needs_browser: parked until a browser fixes it; never blocks the queue.
  needs_browser: {
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // deferred: backoff/breaker wait. RETRY requeues to the right queue.
  deferred: {
    RETRY: (s) =>
      s.stage === 'extract'
        ? { state: 'created' }
        : { state: 'extracted', chars: 0 },
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // enriching (leased).
  enriching: {
    ENRICHED: () => ({ state: 'inbox', enriched: true }),
    ENRICH_FAILED: (_s, e) => ({
      state: 'errored',
      stage: 'enrich',
      error: e.error,
      attempts: e.attempts ?? 1,
      retryable: e.retryable ?? true,
    }),
    DEFER: (_s, e) => ({
      state: 'deferred',
      stage: e.stage,
      nextAttemptAt: e.nextAttemptAt,
      attempts: e.attempts,
      reason: e.reason,
    }),
    LEASE_EXPIRED: () => ({ state: 'extracted', chars: 0 }),
  },

  // inbox: triage moves a link to its action-mapped state.
  inbox: {
    TRIAGE: (_s, e, at) => {
      switch (e.action) {
        case 'read_now': return { state: 'inbox', enriched: true }
        case 'schedule': return { state: 'scheduled', scheduledFor: e.scheduledFor ?? null }
        case 'archive': return { state: 'archived', archivedAt: at.toISOString(), reason: 'manual' }
        case 'discard': return { state: 'discarded', discardedAt: at.toISOString() }
      }
    },
    EXPIRE: (_s, _e, at) => ({ state: 'archived', archivedAt: at.toISOString(), reason: 'expired' }),
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // scheduled: explicit scheduledFor, expiry still applies.
  scheduled: {
    TRIAGE: (_s, e, at) => {
      switch (e.action) {
        case 'read_now': return { state: 'inbox', enriched: true }
        case 'schedule': return { state: 'scheduled', scheduledFor: e.scheduledFor ?? null }
        case 'archive': return { state: 'archived', archivedAt: at.toISOString(), reason: 'manual' }
        case 'discard': return { state: 'discarded', discardedAt: at.toISOString() }
      }
    },
    EXPIRE: (_s, _e, at) => ({ state: 'archived', archivedAt: at.toISOString(), reason: 'expired' }),
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // archived / discarded: restorable or deletable.
  archived: {
    RESTORE: () => ({ state: 'inbox', enriched: true }),
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },
  discarded: {
    RESTORE: () => ({ state: 'inbox', enriched: true }),
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // errored: retryable errors go back to their queue.
  errored: {
    RETRY: (s, e) =>
      (e.stage ?? s.stage) === 'extract'
        ? { state: 'created' }
        : { state: 'extracted', chars: 0 },
    DELETE: (_s, _e, at) => ({ state: 'deleted', deletedAt: at.toISOString() }),
  },

  // deleted: terminal tombstone. Nothing leaves.
  deleted: {},
}

/** `[state, event]` pairs with a defined transition, in table order. */
export const TRANSITION_PAIRS: ReadonlyArray<readonly [LinkStateName, LinkEventName]> = (
  Object.entries(TABLE) as Array<[LinkStateName, Partial<Record<LinkEventName, AnyHandler>>]>
).flatMap(([s, handlers]) =>
  (Object.keys(handlers) as LinkEventName[]).map((e) => [s, e] as const),
)

/** Lookup map keyed by `"state:event"`. */
export const TRANSITIONS: ReadonlyMap<string, AnyHandler> = new Map(
  TRANSITION_PAIRS.map(([s, e]) => [`${s}:${e}`, TABLE[s][e] as AnyHandler]),
)

/** The table as a plain nested object (used by the docs generator). */
export function transitionTable(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [s, handlers] of Object.entries(TABLE)) {
    out[s] = Object.keys(handlers)
  }
  return out
}
