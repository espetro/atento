import { z } from 'zod/mini'
import { PARK_REASONS } from '../pipeline/park-reason.js'

/**
 * The linkinbox finite state machine: events.
 *
 * An event carries everything a transition needs (payload + `at` clock).
 * The store applies events atomically with a compare-and-set on the state.
 */

const iso = z.iso.datetime({ offset: true })
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

export const extractStartedEvent = z.extend(baseEvent, {
  type: z.literal('EXTRACT_STARTED'),
  attempt: z.optional(z.number().check(z.int(), z.minimum(1))),
  /** The journal run owning the lease, for crash reclaim. */
  runId: z.optional(z.number().check(z.int(), z.positive())),
})
export const extractedEvent = z.extend(baseEvent, {
  type: z.literal('EXTRACTED'),
  chars: z.number().check(z.int(), z.minimum(0)),
})
export const needsBrowserEvent = z.extend(baseEvent, {
  type: z.literal('NEEDS_BROWSER'),
  host: z.optional(z.string()),
  /** Why a browser is needed, e.g. `login_wall` or `private_404`. */
  reason: z.optional(z.string()),
  /** The park reason class decided by the extract stage. */
  reasonClass: z.optional(z.enum(PARK_REASONS)),
})
export const extractFailedEvent = z.extend(baseEvent, {
  type: z.literal('EXTRACT_FAILED'),
  error: z.string(),
  retryable: z.optional(z.boolean()),
  attempts: z.optional(z.number().check(z.int(), z.minimum(0))),
})
export const deferEvent = z.extend(baseEvent, {
  type: z.literal('DEFER'),
  stage: stageEnum,
  nextAttemptAt: iso,
  attempts: z.number().check(z.int(), z.minimum(0)),
  reason: z.string(),
  /** The park reason class, when the deferral parks the link. */
  reasonClass: z.optional(z.enum(PARK_REASONS)),
})
export const enrichStartedEvent = z.extend(baseEvent, {
  type: z.literal('ENRICH_STARTED'),
  attempt: z.optional(z.number().check(z.int(), z.minimum(1))),
  /** The journal run owning the lease, for crash reclaim. */
  runId: z.optional(z.number().check(z.int(), z.positive())),
})
export const enrichedEvent = z.extend(baseEvent, { type: z.literal('ENRICHED') })
export const enrichFailedEvent = z.extend(baseEvent, {
  type: z.literal('ENRICH_FAILED'),
  error: z.string(),
  retryable: z.optional(z.boolean()),
  attempts: z.optional(z.number().check(z.int(), z.minimum(0))),
})
export const triageEvent = z.extend(baseEvent, {
  type: z.literal('TRIAGE'),
  action: z.enum(['read_now', 'schedule', 'archive', 'discard']),
  /** For action=schedule. */
  scheduledFor: z.optional(iso),
})
export const expireEvent = z.extend(baseEvent, { type: z.literal('EXPIRE') })
export const restoreEvent = z.extend(baseEvent, { type: z.literal('RESTORE') })
export const retryEvent = z.extend(baseEvent, {
  type: z.literal('RETRY'),
  stage: z.optional(stageEnum),
})
export const leaseExpiredEvent = z.extend(baseEvent, { type: z.literal('LEASE_EXPIRED') })
export const deleteEvent = z.extend(baseEvent, { type: z.literal('DELETE') })

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

/** zod-validated parse of a persisted event payload. */
export function parseLinkEvent(raw: unknown): LinkEvent {
  const parsed = LinkEventSchema.parse(raw)
  return parsed
}
