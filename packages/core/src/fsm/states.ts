import { z } from 'zod/mini'
import { PARK_REASONS } from '../pipeline/park-reason.js'

/**
 * The atento finite state machine: states.
 *
 * Every persisted link has exactly one current state, stored as
 * `links.state` (the discriminant) plus `links.state_data` (the variant
 * payload). The legacy `links.status` column is kept as a coarse projection
 * of the FSM state (see `legacyStatus`) so the REST contract and the UI keep
 * working.
 */

// ---- variant payloads -------------------------------------------------

export const createdSchema = z.object({ state: z.literal('created') })

export const extractingSchema = z.object({
  state: z.literal('extracting'),
  startedAt: z.string(),
  attempt: z.number().check(z.int(), z.minimum(1)),
  /** The journal run that owns this lease (crash reclaim key). */
  runId: z.optional(z.number().check(z.int(), z.positive())),
})

export const extractedSchema = z.object({
  state: z.literal('extracted'),
  /** Characters of extracted content. 0 means "unknown". */
  chars: z.number().check(z.int(), z.minimum(0)),
})

export const needsBrowserSchema = z.object({
  state: z.literal('needs_browser'),
  /** Older rows were parked without a host; they parse as an empty host. */
  host: z._default(z.string(), ''),
  /** Why a browser is needed, e.g. `login_wall` or `private_404`. */
  reason: z.optional(z.string()),
  /**
   * The park reason class of the parked link: `login_wall`, `bot_block`,
   * `js_shell`, `http_error`, `timeout` or `review_only`. Older rows were
   * parked without one; they parse as `unknown`.
   */
  reasonClass: z._default(z.enum(PARK_REASONS), 'unknown'),
})

export const deferredSchema = z.object({
  state: z.literal('deferred'),
  stage: z.enum(['extract', 'enrich']),
  nextAttemptAt: z.string(),
  attempts: z.number().check(z.int(), z.minimum(0)),
  reason: z.string(),
  /**
   * The park reason class of the deferral, when it names a blocker. A pure
   * throttle (spacing, daily cap) carries no class: it parses as `unknown`.
   */
  reasonClass: z._default(z.enum(PARK_REASONS), 'unknown'),
})

export const enrichingSchema = z.object({
  state: z.literal('enriching'),
  startedAt: z.string(),
  attempt: z.number().check(z.int(), z.minimum(1)),
  /** The journal run that owns this lease (crash reclaim key). */
  runId: z.optional(z.number().check(z.int(), z.positive())),
})

export const inboxSchema = z.object({
  state: z.literal('inbox'),
  enriched: z.boolean(),
})

export const scheduledSchema = z.object({
  state: z.literal('scheduled'),
  scheduledFor: z.nullable(z.string()),
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
  attempts: z.number().check(z.int(), z.minimum(0)),
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
export const LINK_STATES = LinkStateSchema._zod.def.options.map(
  // zod/mini literals keep their values on `_zod.def.values`; there is no
  // `.options`/`.value` accessor like classic zod exposes.
  (o) => o.shape.state._zod.def.values[0],
) as [LinkStateName, ...LinkStateName[]]

/** States that carry a lease (`startedAt`). */
export const LEASED_STATES: LinkStateName[] = ['extracting', 'enriching']

/** The one terminal state. Nothing transitions out of it. */
export const TERMINAL_STATE: LinkStateName = 'deleted'

// ---- helpers ------------------------------------------------------------

export function isTerminal(state: LinkState): boolean {
  return state.state === TERMINAL_STATE
}

/** Leased processing states: extracting, enriching. */
export function isProcessing(state: LinkState): boolean {
  return LEASED_STATES.includes(state.state)
}

/** States a user can act on: inbox and scheduled. */
export function isActionable(state: LinkState): boolean {
  return state.state === 'inbox' || state.state === 'scheduled'
}

/** The fine-grained public projection of a state. */
export type PublicStatus =
  | 'inbox'
  | 'scheduled'
  | 'archived'
  | 'discarded'
  | 'created'
  | 'extracting'
  | 'extracted'
  | 'needs_browser'
  | 'deferred'
  | 'enriching'
  | 'errored'
  | 'deleted'

export function publicStatus(state: LinkState): PublicStatus {
  return state.state
}

/**
 * The legacy five-value status projection. This is what the `links.status`
 * column stores, so every legacy consumer keeps working unchanged.
 */
export type LegacyStatus = 'inbox' | 'scheduled' | 'archived' | 'discarded' | 'deleted'

export function legacyStatus(state: LinkState): LegacyStatus {
  switch (state.state) {
    case 'inbox': return 'inbox'
    case 'scheduled': return 'scheduled'
    case 'archived': return 'archived'
    case 'discarded': return 'discarded'
    case 'deleted': return 'deleted'
    default: return 'inbox'
  }
}

/** Thrown when a persisted row carries a state the FSM does not know. */
export class InvalidState extends Error {
  readonly code = 'INVALID_STATE' as const
  constructor(
    readonly state: string,
    message?: string,
  ) {
    super(message ?? `invalid link state "${state}"`)
    this.name = 'InvalidState'
  }
}

/** zod-validated parse of a persisted state (never trust raw rows). */
export function parseLinkState(state: string, data: unknown): LinkState {
  const payload =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  const parsed = LinkStateSchema.safeParse({ state, ...payload })
  if (!parsed.success) {
    throw new InvalidState(state, parsed.error.message)
  }
  return parsed.data
}
