/**
 * The capture client: one POST to /capture with the bearer token.
 *
 * Deliberately thin: the queue owns retry policy, the payload builder owns
 * the wire shape, and this module only knows how to send once and read the
 * response outcome. The fetch is injected, so no test ever opens a socket.
 */
import type { CapturePayload } from './payload.js'
import { serializeCapturePayload } from './payload.js'

export type PostResult =
  | { ok: true; outcome: 'created' | 'updated' | 'duplicate'; id?: number }
  | { ok: false; status?: number; error: string }

export interface PostOptions {
  endpoint: string
  token: string
  /** Injected fetch. Tests pass a fake. */
  fetch?: typeof fetch
}

/** POST the payload once. Never throws; errors come back as ok: false. */
export async function postCapture(
  payload: CapturePayload,
  options: PostOptions,
): Promise<PostResult> {
  const doFetch = options.fetch ?? fetch
  try {
    const res = await doFetch(options.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      body: serializeCapturePayload(payload),
    })
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    }
    const body = (await res.json().catch(() => ({}))) as {
      outcome?: string
      id?: number
    }
    return {
      ok: true,
      outcome:
        body.outcome === 'created' || body.outcome === 'updated' || body.outcome === 'duplicate'
          ? body.outcome
          : 'created',
      id: body.id,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
