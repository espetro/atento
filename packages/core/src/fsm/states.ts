import { z } from 'zod'

/**
 * The linkinbox finite state machine.
 *
 * Every persisted link has exactly one current state, stored as
 * `links.state` (the discriminant) plus `links.state_data` (the
 * variant payload). The legacy `links.status` column is kept as a pure
 * projection of the FSM state (see `publicStatus`) so the REST contract
 * and UI keep working.
 */

// ---- variant payloads -------------------------------------------------

export const createdSchema = z.object({ state: z.literal('created') })

export const extractingSchema = z.object({
  state: z.literal('extracting'),
  startedAt: z.string(),
  attempt: z.number().int().min(1),
})

export const extractedSchema = z.object({
  state: z.literal('extracted'),
  chars: z.number().int().min(0),
})

export const needsBrowserSchema = z.object({
  state: z.literal('needs_browser'),
  host: z.string(),
})

export const deferredSchema = z.object({
  state: z.literal('deferred'),
  stage: z.enum(['extract', 'enrich']),
  nextAttemptAt: z.string(),
  attempts: z.number().int().min(0),
  reason: z.string(),
})

export const enrichingSchema = z.object({
  state: z.literal('enriching'),
  startedAt: z.string(),
  attempt: z.number().int().min(1),
})

export const inboxSchema = z.object({
  state: z.literal('inbox'),
  enriched: z.boolean(),
})

export const scheduledSchema = z.object({
  state: z.literal('scheduled'),
  scheduledFor: z.string().nullable(),
})

export const archivedSchema = z.object({
  state: z.literal('archived'),
  archivedAt: z.string(),
  reason: z.enum(['manual', 'expired']),
})

export const discardedSchema = z.object({
  state: z.literal('discarded'),
  discardedAt: z.string(),
})

export const erroredSchema = z.object({
  state: z.literal('errored'),
  stage: z.enum(['extract', 'enrich']),
  error: z.string(),
  attempts: z.number().int().min(0),
  retryable: z.boolean(),
})

export const deletedSchema = z.object({
  state: z.literal('deleted'),
  deletedAt: z.string(),
})

/** The discriminated union of all states. Discriminant: `state`. */
export const LinkStateSchema = z.discriminatedUnion('state', [
  createdSchema,
  extractingSchema,
  extractedSchema,
  needsBrowserSchema,
  deferredSchema,
  enrichingSchema,
  inboxSchema,
  scheduledSchema,
  archivedSchema,
  discardedSchema,
  erroredSchema,
  deletedSchema,
])

export type LinkState = z.infer<typeof LinkStateSchema>
export type LinkStateName = LinkState['state']

/** All state names, in stable order (used by the transition table and docs). */
export const LINK_STATES = LinkStateSchema.options.map((o) => o.shape.state.value) as [
  LinkStateName,
  ...LinkStateName[],
]

export const TERMINAL_STATES: LinkStateName[] = ['deleted']
/** Processing states carry a lease (`startedAt`). */
export const LEASED_STATES: LinkStateName[] = ['extracting', 'enriching']

// ---- events -----------------------------------------------------------

const iso = z.string().datetime({ offset: true })
const stageEnum = z.enum(['extract', 'enrich'])

export const LINK_EVENTS = [
  'EXTRACT_STARTED',
  'EXTRACTED',
  'NEEDS_BROWSER',
  'EXTRACT_FAILED',
  'DEFER',
  'ENRICH_STARTED',
  'ENRICHED',
  'ENRICH_FAILED',
  'TRIAGE',
  'EXPIRE',
  'RESTORE',
  'RETRY',
  'LEASE_EXPIRED',
  'DELETE',
] as const
export type LinkEventName = (typeof LINK_EVENTS)[number]

const baseEvent = z.object({ at: iso })

export const extractStartedEvent = baseEvent.extend({
  type: z.literal('EXTRACT_STARTED'),
  attempt: z.number().int().min(1).optional(),
})
export const extractedEvent = baseEvent.extend({
  type: z.literal('EXTRACTED'),
  chars: z.number().int().min(0),
})
export const needsBrowserEvent = baseEvent.extend({
  type: z.literal('NEEDS_BROWSER'),
  host: z.string().optional(),
})
export const extractFailedEvent = baseEvent.extend({
  type: z.literal('EXTRACT_FAILED'),
  error: z.string(),
  retryable: z.boolean().optional(),
  attempts: z.number().int().min(0).optional(),
})
export const deferEvent = baseEvent.extend({
  type: z.literal('DEFER'),
  stage: stageEnum,
  nextAttemptAt: iso,
  attempts: z.number().int().min(0),
  reason: z.string(),
})
export const enrichStartedEvent = baseEvent.extend({
  type: z.literal('ENRICH_STARTED'),
  attempt: z.number().int().min(1).optional(),
})
export const enrichedEvent = baseEvent.extend({ type: z.literal('ENRICHED') })
export const enrichFailedEvent = baseEvent.extend({
  type: z.literal('ENRICH_FAILED'),
  error: z.string(),
  retryable: z.boolean().optional(),
  attempts: z.number().int().min(0).optional(),
})
export const triageEvent = baseEvent.extend({
  type: z.literal('TRIAGE'),
  action: z.enum(['read_now', 'schedule', 'archive', 'discard']),
  /** For action=schedule. */
  scheduledFor: iso.optional(),
})
export const expireEvent = baseEvent.extend({ type: z.literal('EXPIRE') })
export const restoreEvent = baseEvent.extend({ type: z.literal('RESTORE') })
export const retryEvent = baseEvent.extend({
  type: z.literal('RETRY'),
  stage: stageEnum.optional(),
})
export const leaseExpiredEvent = baseEvent.extend({ type: z.literal('LEASE_EXPIRED') })
export const deleteEvent = baseEvent.extend({ type: z.literal('DELETE') })

/** The discriminated union of all events. Discriminant: `type`. */
export const LinkEventSchema = z.discriminatedUnion('type', [
  extractStartedEvent,
  extractedEvent,
  needsBrowserEvent,
  extractFailedEvent,
  deferEvent,
  enrichStartedEvent,
  enrichedEvent,
  enrichFailedEvent,
  triageEvent,
  expireEvent,
  restoreEvent,
  retryEvent,
  leaseExpiredEvent,
  deleteEvent,
])

export type LinkEvent = z.infer<typeof LinkEventSchema>

// ---- errors and results -----------------------------------------------

export class IllegalTransition extends Error {
  readonly code = 'ILLEGAL_TRANSITION' as const
  constructor(
    readonly from: LinkStateName,
    readonly event: LinkEventName,
    message?: string,
  ) {
    super(message ?? `illegal transition: ${event} is not allowed from ${from}`)
    this.name = 'IllegalTransition'
  }
}

export type TransitionResult =
  | { ok: true; state: LinkState; from: LinkStateName; event: LinkEventName }
  | { ok: false; error: IllegalTransition }

// ---- the transition table ----------------------------------------------

type Handler<S extends LinkStateName, E extends LinkEventName> = (
  state: Extract<LinkState, { state: S }>,
  event: Extract<LinkEvent, { type: E }>,
  at: Date,
) => LinkState

type AnyHandler = (state: LinkState, event: LinkEvent, at: Date) => LinkState

/**
 * The table type requires an entry for EVERY state, so adding a state to
 * LinkStateSchema without handling it here fails typecheck.
 */
type StateTable = {
  [S in LinkStateName]: Partial<{ [E in LinkEventName]: Handler<S, E> }>
}

function defineTable(table: StateTable): StateTable {
  return table
}

/**
 * The single source of truth for allowed transitions. Every pair listed here
 * is legal; every other (state, event) pair is rejected with
 * IllegalTransition. Nothing transitions out of `deleted`.
 */
const TABLE = defineTable({
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
    RETRY: (s) => (s.stage === 'extract' ? { state: 'created' } : { state: 'extracted', chars: 0 }),
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
})

/** `[state, event]` pairs with a defined transition, in table order. */
export const TRANSITION_PAIRS: ReadonlyArray<readonly [LinkStateName, LinkEventName]> = (
  Object.entries(TABLE) as Array<[LinkStateName, Partial<Record<LinkEventName, AnyHandler>>]>
).flatMap(([s, handlers]) =>
  (Object.keys(handlers) as LinkEventName[]).map((e) => [s, e] as const),
)

export const TRANSITIONS: ReadonlyMap<string, AnyHandler> = new Map(
  TRANSITION_PAIRS.map(([s, e]) => [
    `${s}:${e}`,
    TABLE[s][e] as AnyHandler,
  ]),
)

// ---- pure transition function -------------------------------------------

/** Apply one event to one state. Pure: never touches storage. */
export function transition(state: LinkState, event: LinkEvent, at: Date = new Date()): TransitionResult {
  const handler = TRANSITIONS.get(`${state.state}:${event.type}`)
  if (!handler) {
    return { ok: false, error: new IllegalTransition(state.state, event.type) }
  }
  return { ok: true, state: handler(state, event, at), from: state.state, event: event.type }
}

// ---- helpers ------------------------------------------------------------

export function isTerminal(state: LinkState): boolean {
  return state.state === 'deleted'
}

/** Leased processing states: extracting, enriching. */
export function isProcessing(state: LinkState): boolean {
  return LEASED_STATES.includes(state.state)
}

/** States a user can act on from `list`/`show`: inbox and scheduled. */
export function isActionable(state: LinkState): boolean {
  return state.state === 'inbox' || state.state === 'scheduled'
}

/**
 * Legacy coarse status, the projection every external surface consumes.
 * Derived from the FSM state, never stored by the FSM itself (the
 * `links.status` column is maintained by the store projection).
 */
export type PublicStatus =
  | 'inbox'
  | 'scheduled'
  | 'archived'
  | 'discarded'
  | 'created'
  | 'extracting'
  | 'enriching'
  | 'deferred'
  | 'errored'
  | 'deleted'

export function publicStatus(state: LinkState): PublicStatus {
  switch (state.state) {
    case 'inbox': return 'inbox'
    case 'scheduled': return 'scheduled'
    case 'archived': return 'archived'
    case 'discarded': return 'discarded'
    case 'created': return 'created'
    case 'extracting': return 'extracting'
    case 'enriching': return 'enriching'
    case 'deferred': return 'deferred'
    case 'errored': return 'errored'
    case 'deleted': return 'deleted'
    case 'extracted': return 'created'
    case 'needs_browser': return 'created'
  }
}

/** zod-validated parse of a persisted state (never trust raw rows). */
export function parseLinkState(state: string, data: unknown): LinkState {
  return LinkStateSchema.parse({ state, ...(typeof data === 'object' && data !== null ? data : {}) })
}
