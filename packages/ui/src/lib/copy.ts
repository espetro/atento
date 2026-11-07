/**
 * Per-collection display metadata + remediation copy. Shared by the
 * attention banner, the run view's needs-action panel and the rail so the
 * strings never diverge (spec: keep remediation copy in one place).
 */
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

export const COLLECTION_META: Record<string, CollectionMeta> = {
  enriched: {
    tone: 'enriched',
    label: 'enriched',
    meaning: 'Extracted and enriched — ready to read.',
    remediation: '',
  },
  pending: {
    tone: 'pending',
    label: 'pending',
    meaning: 'Waiting on extract or enrich — the pipeline will pick these up.',
    remediation: '',
  },
  needs_login: {
    tone: 'needs-login',
    label: 'needs login',
    meaning:
      'These links need a logged-in browser session. The pipeline parks them instead of guessing.',
    remediation:
      'Run `linkinbox login <host>` in a terminal, then run the pipeline again — parked links resume automatically.',
  },
  blocked: {
    tone: 'blocked',
    label: 'blocked',
    meaning:
      'Parked by a bot block, JS shell, HTTP error or timeout — the extractor could not read the page.',
    remediation:
      'Retry later, re-extract with another adapter, or archive the links you do not need.',
  },
  errored: {
    tone: 'errored',
    label: 'errored',
    meaning: 'The extract or enrich stage threw on these links.',
    remediation: 'Inspect the error, re-extract (r) or discard (d).',
  },
  review: {
    tone: 'review',
    label: 'review',
    meaning:
      'Hosts on the review list are never fetched automatically — a human reviews them by design.',
    remediation: 'Open and read each link, then archive or keep it.',
  },
  triaged: {
    tone: 'triaged',
    label: 'triaged',
    meaning: 'Scheduled, archived or discarded — decisions already made.',
    remediation: '',
  },
}

export const ATTENTION_COLLECTIONS: CollectionName[] = [
  'needs_login',
  'blocked',
  'errored',
  'review',
]

export function collectionMeta(name: string): CollectionMeta {
  return (
    COLLECTION_META[name] ?? {
      tone: 'default',
      label: name,
      meaning: '',
      remediation: '',
    }
  )
}

/** Human label for a raw park reason / FSM reason string. */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return ''
  return reason.replace(/_/g, ' ')
}
