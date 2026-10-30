/**
 * The capture flow: action click to POST.
 *
 * All browser APIs are injected, so the whole flow is unit tested offline
 * with fakes and never opens a socket. The chrome wiring lives in
 * background.ts; this module owns the decisions.
 *
 * The flow is: read the active tab, refuse private windows and denied
 * hosts, extract the page through the injected extractor, build the
 * /capture payload and send it. A failed send is queued, never dropped.
 */
import { decideCapture, DEFAULT_DENY_LIST, type DenyPattern } from './guard.js'
import { buildCapturePayload, type CapturePayload } from './payload.js'
import type { ExtractedPage } from './extractor.js'

/** The tab facts the flow needs. */
export interface CaptureTab {
  id?: number
  url: string
  title?: string | undefined
  /** True when the tab lives in a private window. */
  incognito?: boolean
}

export interface CaptureDeps {
  /** The tab to capture. */
  tab: CaptureTab
  /** Extract the page content. Returns null when extraction failed. */
  extract: (tab: CaptureTab) => Promise<ExtractedPage | null>
  /** The bearer token from chrome.storage.local. Empty when unset. */
  getToken: () => Promise<string>
  /** Send the payload. Returns ok on success. */
  send: (payload: CapturePayload, token: string) => Promise<{ ok: boolean; error?: string }>
  /** Queue the payload for a later retry. */
  enqueue: (payload: CapturePayload) => boolean
  /** The effective deny list. */
  denyList?: DenyPattern[]
  /** Client identity, e.g. "extension@browseros". */
  source?: string
  /** Capture time, injected for deterministic tests. */
  now?: Date
}

export type CaptureOutcome =
  | { status: 'captured'; payload: CapturePayload }
  | { status: 'queued'; payload: CapturePayload; error: string }
  | { status: 'refused'; reason: string }
  | { status: 'no_token' }
  | { status: 'extraction_failed' }

/**
 * Capture the active tab. Never throws: every failure comes back as an
 * outcome the caller can report.
 */
export async function runActiveTabCapture(deps: CaptureDeps): Promise<CaptureOutcome> {
  const { tab } = deps
  if (tab.incognito === true) {
    return { status: 'refused', reason: 'private window' }
  }
  const decision = decideCapture(tab.url, deps.denyList ?? DEFAULT_DENY_LIST)
  if (!decision.allowed) {
    return { status: 'refused', reason: decision.reason ?? 'denied' }
  }
  const token = await deps.getToken()
  if (token.trim() === '') {
    return { status: 'no_token' }
  }
  const extracted = await deps.extract(tab)
  if (extracted === null || extracted.body.trim() === '') {
    return { status: 'extraction_failed' }
  }
  const payload = buildCapturePayload(
    {
      url: tab.url,
      title: extracted.title ?? tab.title,
      body: extracted.body,
      selection: extracted.selection,
      meta: extracted.meta,
    },
    { source: deps.source, now: deps.now },
  )
  const result = await deps.send(payload, token)
  if (result.ok) {
    return { status: 'captured', payload }
  }
  const queued = deps.enqueue(payload)
  return {
    status: 'queued',
    payload,
    error: result.error ?? (queued ? 'server unreachable' : 'server unreachable, queue full'),
  }
}
