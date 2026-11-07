/**
 * The pairing client: exchange a one-time code for bearer tokens.
 *
 * Contract (server: packages/server/src/pairing.ts):
 *   POST {serverUrl}/api/pair  {"code": "ABCDEFGH"}
 *   -> 200 {"captureToken": string|null, "serverToken": string|null}
 *   -> 401 unknown/expired/used code, 400 malformed body
 *
 * The fetch is injected so tests never open a socket.
 */
import { pairUrl, type ServerSettings } from './config.js'

export type PairResult =
  | { ok: true; captureToken: string | null; serverToken: string | null }
  | { ok: false; status?: number; error: string }

export interface PairOptions {
  settings: ServerSettings
  /** Injected fetch. Tests pass a fake. */
  fetch?: typeof fetch
}

/** Redeem a pairing code. Never throws. */
export async function redeemPairingCode(code: string, options: PairOptions): Promise<PairResult> {
  const doFetch = options.fetch ?? fetch
  try {
    const res = await doFetch(pairUrl(options.settings), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim() }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => null)
      const message =
        detail !== null && typeof detail === 'object' && 'error' in detail
          ? String((detail as { error: unknown }).error)
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, error: message }
    }
    const body = (await res.json().catch(() => ({}))) as {
      captureToken?: unknown
      serverToken?: unknown
    }
    return {
      ok: true,
      captureToken: typeof body.captureToken === 'string' ? body.captureToken : null,
      serverToken: typeof body.serverToken === 'string' ? body.serverToken : null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
