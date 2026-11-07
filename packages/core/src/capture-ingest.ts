/**
 * Capture ingest: a client POSTed content it already extracted in the user's
 * own logged-in session. Dedupe by normalized url hash (the same key the
 * importers use), store the supplied body, and move the link straight to
 * `extracted` so the pipeline skips the headless extract step and goes to
 * enrich. Trust and freshness rules decide whether an existing link is
 * updated.
 */
import type { Store, Link, LinkPatch } from './store.js'
import { normalizeUrl } from './url.js'
import type { Capture } from './capture.js'
import {
  TRUST_CAPTURED,
  TRUST_HEADLESS_PROFILE,
  TRUST_ANONYMOUS,
} from './capture.js'
import type { CaptureConfig } from './capture.js'

/**
 * Trust tier for a stored link's content, derived from its source. A capture
 * from the user's own session outranks a headless browser run, which
 * outranks an anonymous fetch. The `source` names the client, so the tier is
 * decided by the pipeline that recorded the link, not by config.
 *
 * A source is treated as captured when it was recorded through the capture
 * ingest (the `captured` marker). Headless profile extraction records the
 * extractor route; anonymous extraction records it too. The tiers here are
 * only compared when the store already knows both rows.
 */
export function trustTier(opts: { captured?: boolean; needsBrowser?: boolean }): number {
  if (opts.captured === true) return TRUST_CAPTURED
  if (opts.needsBrowser === true) return TRUST_HEADLESS_PROFILE
  return TRUST_ANONYMOUS
}

export interface CaptureIngestResult {
  /** The stored link (created, updated or untouched). */
  link: Link
  /** What happened: created, updated, dedupe (no-op) or rejected-stale. */
  outcome: 'created' | 'updated' | 'duplicate' | 'superseded'
}

/**
 * Ingest one capture. A new url is stored with `source` set to the client's
 * source and the `captured` marker, with the supplied body applied through an
 * EXTRACTED transition so the state machine records the skip. A known url is
 * updated only when the capture is newer AND the stored content is empty or
 * came from a lower-trust source. Everything else is a no-op.
 */
export async function captureIngest(
  store: Store,
  capture: Capture,
  options: { now?: Date; config?: CaptureConfig } = {},
): Promise<CaptureIngestResult> {
  const now = options.now ?? new Date()
  const capturedAt = new Date(capture.capturedAt)
  const { url, hash } = normalizeUrl(capture.url)
  const existing = await store.getLinkByUrlHash(hash)

  if (!existing) {
    const created = await store.upsertLink({
      urlHash: hash,
      url,
      title: capture.title ?? null,
      source: capture.source,
      addedAt: capturedAt,
      note: null,
      tags: null,
      status: 'inbox',
      needsBrowser: false,
      captured: true,
      capturedAt,
      state: 'created',
      stateData: {},
    })
    // Apply the content through the FSM so the history shows exactly why the
    // headless extract step was skipped. The body, its timestamp and the
    // transition commit in ONE transaction: an ack is only ever sent for a
    // fully committed capture.
    const done = await store.applyEvent(
      created.id,
      {
        type: 'EXTRACTED',
        chars: capture.body.length,
        at: now.toISOString(),
      },
      'created',
      {
        extractedContent: capture.body,
        needsBrowser: false,
        extractedAt: capturedAt,
      },
    )
    if (!done.ok) {
      // A concurrent runner moved the link first: leave it alone.
      const link = (await store.getLink(created.id)) as Link
      return { link, outcome: 'duplicate' }
    }
    return { link: (await store.getLink(created.id)) as Link, outcome: 'created' }
  }

  // Known url. A tombstone never comes back.
  if (existing.state === 'deleted') {
    return { link: existing, outcome: 'duplicate' }
  }

  const storedTrust = trustTier({
    captured: existing.captured,
    needsBrowser: existing.needsBrowser,
  })
  const newer = existing.extractedAt === null || capturedAt > existing.extractedAt
  const updatable =
    existing.extractedContent === null ||
    existing.extractedContent.trim() === '' ||
    storedTrust < TRUST_CAPTURED

  if (!newer || !updatable) {
    return { link: existing, outcome: 'duplicate' }
  }

  // Update path: only when the stored content is empty or lower-trust, and
  // the capture is newer than whatever is stored. Body, capture markers and
  // title fill commit atomically — with the EXTRACTED transition when the
  // link is still queued, as a plain column patch otherwise.
  const patch: LinkPatch = {
    extractedContent: capture.body,
    needsBrowser: false,
    extractedAt: capturedAt,
    captured: true,
    capturedAt,
  }
  if (capture.title !== undefined && existing.title === null) {
    patch.title = capture.title
  }
  // Keep the state consistent: a link still queued for extraction jumps to
  // extracted with the supplied content; anything further along is left as is.
  if (existing.state === 'created') {
    const done = await store.applyEvent(
      existing.id,
      {
        type: 'EXTRACTED',
        chars: capture.body.length,
        at: now.toISOString(),
      },
      'created',
      patch,
    )
    if (!done.ok) {
      // The link moved between the read and the write (e.g. a runner claimed
      // it): the event+patch rolled back together, so land the content as a
      // plain atomic patch — same guarantee the old unconditional writes gave.
      await store.patchLink(existing.id, patch)
    }
  } else {
    await store.patchLink(existing.id, patch)
  }
  return { link: (await store.getLink(existing.id)) as Link, outcome: 'updated' }
}
