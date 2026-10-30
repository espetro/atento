/**
 * The /capture payload builder.
 *
 * The wire shape is the existing server contract from docs/capture.md and
 * packages/core/src/capture.ts: url, title, capturedAt, contentType, body,
 * selection, meta and source. Nothing new is required by the extension, so
 * the payload is built exactly as the server expects it.
 *
 * The builder is a pure function over a tab snapshot. It never touches the
 * browser APIs and never touches the network, so the tests are plain unit
 * tests with fixtures.
 */

/** What the builder needs to know about a tab. */
export interface TabSnapshot {
  url: string
  title?: string | undefined
  /** The extracted page content, markdown or plain text. */
  body: string
  /** The user's quoted fragment, when there is one. */
  selection?: string | undefined
  /** Client metadata: video signals, client identity, anything free-form. */
  meta?: Record<string, unknown> | undefined
}

/** The body of a POST /capture request. */
export interface CapturePayload {
  url: string
  title?: string
  capturedAt: string
  contentType: 'page'
  body: string
  selection?: string
  meta?: Record<string, unknown>
  source: string
}

/** The client identity stored as the link's source. */
export const DEFAULT_SOURCE = 'extension'

/** Only page captures exist today. */
export const CONTENT_TYPE_PAGE = 'page' as const

export interface BuildPayloadOptions {
  /** Client identity, e.g. "extension" or "extension@browseros". */
  source?: string
  /** Capture time. Injected so the tests are deterministic. */
  now?: Date
}

/**
 * Build the /capture body from a tab snapshot.
 *
 * A blank title or a blank selection is dropped rather than sent as an
 * empty string: the server stores the title only when the link has none,
 * and an empty selection is noise.
 */
export function buildCapturePayload(
  tab: TabSnapshot,
  options: BuildPayloadOptions = {},
): CapturePayload {
  const now = options.now ?? new Date()
  const payload: CapturePayload = {
    url: tab.url,
    capturedAt: now.toISOString(),
    contentType: CONTENT_TYPE_PAGE,
    body: tab.body,
    source: options.source ?? DEFAULT_SOURCE,
  }
  const title = tab.title?.trim()
  if (title !== undefined && title !== '') payload.title = title
  const selection = tab.selection?.trim()
  if (selection !== undefined && selection !== '') payload.selection = selection
  if (tab.meta !== undefined && Object.keys(tab.meta).length > 0) {
    payload.meta = { ...tab.meta }
  }
  return payload
}

/**
 * Serialise the payload for the wire. The server parses JSON, so this is
 * the whole body of the POST.
 */
export function serializeCapturePayload(payload: CapturePayload): string {
  return JSON.stringify(payload)
}
