import { describe, expect, it } from 'vitest'
import { createLinkinboxClient } from '../src/index.js'

interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
}

function stubFetch(body: unknown, status = 200) {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // openapi-fetch hands fetch a Request object; normalize either shape.
    const req = input instanceof Request ? input : new Request(input, init)
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body === null ? undefined : await req.json().catch(() => undefined),
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('createLinkinboxClient', () => {
  it('issues typed GET requests against the configured base url', async () => {
    const { calls, fetchImpl } = stubFetch({ links: [], nextCursor: null })
    const client = createLinkinboxClient({
      baseUrl: 'http://127.0.0.1:4173',
      fetch: fetchImpl,
    })
    const { data, error } = await client.GET('/api/links')
    expect(error).toBeUndefined()
    expect(data).toEqual({ links: [], nextCursor: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:4173/api/links')
    expect(calls[0]!.method).toBe('GET')
  })

  it('sends the bearer token when configured', async () => {
    const { calls, fetchImpl } = stubFetch({ ok: true })
    const client = createLinkinboxClient({
      baseUrl: 'http://example.internal:4173',
      token: 'sekret',
      fetch: fetchImpl,
    })
    await client.GET('/api/metrics')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sekret')
  })

  it('exposes the M3 endpoints with typed params and bodies', async () => {
    const { calls, fetchImpl } = stubFetch({ id: 7, status: 'done' })
    const client = createLinkinboxClient({ baseUrl: 'http://x', fetch: fetchImpl })
    await client.POST('/api/run', { body: { stage: 'all' } })
    expect(calls[0]!.url).toBe('http://x/api/run')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ stage: 'all' })
  })
})
