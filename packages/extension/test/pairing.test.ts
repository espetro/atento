import { describe, expect, it } from 'vitest'
import { redeemPairingCode, type PairResult } from '../src/pairing.js'
import type { ServerSettings } from '../src/config.js'

const settings: ServerSettings = {
  serverUrl: 'http://127.0.0.1:4173',
  token: '',
  apiToken: '',
  source: 'extension',
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init: init ?? {} })
    return handler(u, init ?? {})
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('redeemPairingCode', () => {
  it('POSTs the code to /api/pair and returns the tokens', async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ captureToken: 'cap', serverToken: 'srv' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const result = await redeemPairingCode('  abcd1234 ', {
      settings,
      fetch: fetchImpl,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:4173/api/pair')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'abcd1234' })
    expect(result).toEqual({ ok: true, captureToken: 'cap', serverToken: 'srv' })
  })

  it('maps a 401 to a readable error', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response(JSON.stringify({ error: 'invalid or expired pairing code' }), { status: 401 }),
    )
    const result: PairResult = await redeemPairingCode('bad', { settings, fetch: fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.error).toContain('pairing code')
    }
  })

  it('returns null tokens when the server has none configured', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response(JSON.stringify({ captureToken: null, serverToken: null }), { status: 200 }),
    )
    const result = await redeemPairingCode('code', { settings, fetch: fetchImpl })
    expect(result).toEqual({ ok: true, captureToken: null, serverToken: null })
  })

  it('never throws on a network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as typeof fetch
    const result = await redeemPairingCode('code', { settings, fetch: fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('connection refused')
  })
})
