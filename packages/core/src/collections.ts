/**
 * Collections: named, pipeline-level views over the links table.
 *
 * A collection describes where a link sits in the pipeline, not a schedule.
 * Membership is a pure function of the link's FSM state and state payload,
 * so every adapter (CLI, MCP, HTTP) classifies identically.
 *
 * | Collection   | Membership                                                        |
 * |--------------|-------------------------------------------------------------------|
 * | enriched     | `inbox` with enrichment recorded                                  |
 * | pending      | `created`, `extracting`, `extracted`, `enriching`, a deferred    |
 * |              | link waiting on a pure throttle, or an `inbox` link that lost   |
 * |              | its enrichment (the enrich stage picks it up again)             |
 * | needs_login  | parked (`needs_browser` or blocker-`deferred`) with reason      |
 * |              | class `login_wall`                                                |
 * | blocked      | parked for any other reason: bot_block, js_shell, http_error,    |
 * |              | timeout, skipped, unknown                                         |
 * | errored      | `errored`                                                         |
 * | review       | parked with reason class `review_only` (review-list hosts)        |
 * | triaged      | `scheduled`, `archived`, `discarded`                              |
 *
 * `deleted` links belong to no collection.
 */
import type { Link } from './types.js'
import { PARK_REASONS, parseParkReason, type ParkReason } from './pipeline/park-reason.js'

export const COLLECTION_NAMES = [
  'enriched',
  'pending',
  'needs_login',
  'blocked',
  'errored',
  'review',
  'triaged',
] as const

export type CollectionName = (typeof COLLECTION_NAMES)[number]

export function isCollectionName(value: unknown): value is CollectionName {
  return typeof value === 'string' && (COLLECTION_NAMES as readonly string[]).includes(value)
}

/** The park reason class carried by a state payload, or 'unknown'. */
function reasonClassOf(stateData: Record<string, unknown> | null | undefined): ParkReason {
  if (!stateData) return 'unknown'
  const cls = stateData['reasonClass']
  if (typeof cls === 'string' && (PARK_REASONS as readonly string[]).includes(cls)) {
    return cls as ParkReason
  }
  const reason = stateData['reason'] ?? stateData['error']
  if (typeof reason === 'string') return parseParkReason(reason)
  return 'unknown'
}

/** True when the link carries enrichment (the `enriched` collection test). */
function hasEnrichment(
  link: Pick<Link, 'stateData' | 'enrichment' | 'category'>,
): boolean {
  if (link.enrichment !== null) return true
  const data = link.stateData
  if (data && data['enriched'] === true) return true
  return link.category !== null
}

/**
 * The collection one link belongs to, or null when it is `deleted` (or in
 * a state no collection claims).
 */
export function collectionOfLink(
  link: Pick<Link, 'state' | 'stateData' | 'enrichment' | 'category'>,
): CollectionName | null {
  switch (link.state) {
    case 'created':
    case 'extracting':
    case 'extracted':
    case 'enriching':
      return 'pending'
    case 'inbox':
      // An inbox link without enrichment is still waiting on the enrich
      // stage — pending work, not a finished result.
      return hasEnrichment(link) ? 'enriched' : 'pending'
    case 'deferred': {
      const cls = reasonClassOf(link.stateData)
      // A pure throttle (no blocker class) is a wait, not a park: the link
      // is still pending work.
      if (cls === 'unknown') return 'pending'
      if (cls === 'login_wall') return 'needs_login'
      if (cls === 'review_only') return 'review'
      return 'blocked'
    }
    case 'needs_browser': {
      const cls = reasonClassOf(link.stateData)
      if (cls === 'login_wall') return 'needs_login'
      if (cls === 'review_only') return 'review'
      return 'blocked'
    }
    case 'errored':
      return 'errored'
    case 'scheduled':
    case 'archived':
    case 'discarded':
      return 'triaged'
    default:
      return null
  }
}
