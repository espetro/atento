import { z } from 'zod'

/**
 * The linkinbox finite state machine: events.
 *
 * An event carries everything a transition needs (payload + `at` clock).
 * The store applies events atomically with a compare-and-set on the state.
 */

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
  /** Why a browser is needed, e.g. `login_wall` or `private_404`. */
  reason: z.string().optional(),
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

/** zod-validated parse of a persisted event payload. */
export function parseLinkEvent(raw: unknown): LinkEvent {
  const parsed = LinkEventSchema.parse(raw)
  return parsed
}
