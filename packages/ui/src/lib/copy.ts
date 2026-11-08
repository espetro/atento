/**
 * Per-collection display metadata + remediation copy. Shared by the
 * attention banner, the run view's needs-action panel and the rail so the
 * strings never diverge (spec: keep remediation copy in one place).
 * All user-facing text lives in messages/en.json (Paraglide).
 */
import { m } from '../paraglide/messages.js'
import type { CollectionName } from './types'

export interface CollectionMeta {
  /** chip-state-* suffix. */
  tone: string
  /** Human label. */
  label: string
  /** One-line pipeline meaning. */
  meaning: string
  /** What the human does about it. */
  remediation: string
}

const TONES: Record<string, string> = {
  enriched: 'enriched',
  pending: 'pending',
  needs_login: 'needs-login',
  blocked: 'blocked',
  errored: 'errored',
  review: 'review',
  triaged: 'triaged',
}

export function collectionMeta(name: string): CollectionMeta {
  switch (name) {
    case 'enriched':
      return {
        tone: TONES.enriched!,
        label: m.col_enriched_label(),
        meaning: m.col_enriched_meaning(),
        remediation: '',
      }
    case 'pending':
      return {
        tone: TONES.pending!,
        label: m.col_pending_label(),
        meaning: m.col_pending_meaning(),
        remediation: '',
      }
    case 'needs_login':
      return {
        tone: TONES.needs_login!,
        label: m.col_needs_login_label(),
        meaning: m.col_needs_login_meaning(),
        remediation: m.col_needs_login_remediation(),
      }
    case 'blocked':
      return {
        tone: TONES.blocked!,
        label: m.col_blocked_label(),
        meaning: m.col_blocked_meaning(),
        remediation: m.col_blocked_remediation(),
      }
    case 'errored':
      return {
        tone: TONES.errored!,
        label: m.col_errored_label(),
        meaning: m.col_errored_meaning(),
        remediation: m.col_errored_remediation(),
      }
    case 'review':
      return {
        tone: TONES.review!,
        label: m.col_review_label(),
        meaning: m.col_review_meaning(),
        remediation: m.col_review_remediation(),
      }
    case 'triaged':
      return {
        tone: TONES.triaged!,
        label: m.col_triaged_label(),
        meaning: m.col_triaged_meaning(),
        remediation: '',
      }
    default:
      return { tone: 'default', label: name, meaning: '', remediation: '' }
  }
}

export const ATTENTION_COLLECTIONS: CollectionName[] = [
  'needs_login',
  'blocked',
  'errored',
  'review',
]

/** Human label for a raw park reason / FSM reason string. */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return ''
  return reason.replace(/_/g, ' ')
}
