import { describe, expect, it } from 'vitest'
import {
  backoffDelay,
  classifyOutcome,
  createOutbox,
  parseRetryAfter,
  type FetchLike,
  type KeyValueStorage,
  type OutboxKind,
} from '../src/queue.js'

/** An in-memory chrome.storage.local double. */
function memoryStorage(): KeyValueStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (data.has(key)) out[key] = data.get(key)
      }
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    },
  }
}

/** A scripted fetch: every call pops the next scripted response. */
function scriptedFetch(
  responses: { status?: number; throws?: boolean; retryAfter?: string }[],
): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  let index = 0
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (!next) throw new Error('no scripted response')
    if (next.throws === true) throw new Error('fetch failed')
    const headers = new Headers()
    if (next.retryAfter !== undefined) headers.set('retry-after', next.retryAfter)
    return new Response(JSON.stringify({ outcome: 'created', id: 1 }), {
      status: next.status ?? 201,
      headers,
    })
  }
  return { fetch, calls }
}

const ENDPOINTS: Record<OutboxKind, string> = {
  capture: 'http://127.0.0.1:4173/capture',
  ingest: 'http://127.0.0.1:4173/api/ingest',
}

function makeOutbox(
  overrides: {
    storage?: KeyValueStorage
    fetch?: FetchLike
    now?: () => number
    random?: () => number
    headersFor?: (kind: OutboxKind) => Record<string, string>
    maxAttempts?: number
    maxSize?: number
  } = {},
) {
  return createOutbox({
    storage: overrides.storage ?? memoryStorage(),
    fetch: overrides.fetch ?? (async () => new Response('', { status: 201 })),
    now: overrides.now,
    random: overrides.random ?? (() => 0),
    endpointFor: (kind) => ENDPOINTS[kind],
    ...(overrides.headersFor ? { headersFor: overrides.headersFor } : {}),
    ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
    ...(overrides.maxSize !== undefined ? { maxSize: overrides.maxSize } : {}),
  })
}

async function enqueueCapture(
  outbox: ReturnType<typeof makeOutbox>,
  key = 'capture:https://example.com/a:2026-01-01T00:00:00.000Z',
) {
  return outbox.enqueue({
    idempotencyKey: key,
    kind: 'capture',
    url: 'https://example.com/a',
    payload: '{"url":"https://example.com/a"}',
  })
}

describe('classifyOutcome', () => {
  it('treats network errors as retryable', () => {
    expect(classifyOutcome({ error: 'fetch failed' })).toBe(true)
  })

  it('treats 408, 425, 429 and 5xx as retryable', () => {
    expect(classifyOutcome({ status: 408 })).toBe(true)
    expect(classifyOutcome({ status: 425 })).toBe(true)
    expect(classifyOutcome({ status: 429 })).toBe(true)
    expect(classifyOutcome({ status: 500 })).toBe(true)
    expect(classifyOutcome({ status: 503 })).toBe(true)
  })

  it('treats 401, 403, 400 and other 4xx as not retryable', () => {
    expect(classifyOutcome({ status: 401 })).toBe(false)
    expect(classifyOutcome({ status: 403 })).toBe(false)
    expect(classifyOutcome({ status: 400 })).toBe(false)
    expect(classifyOutcome({ status: 404 })).toBe(false)
    expect(classifyOutcome({ status: 413 })).toBe(false)
  })

  it('treats 2xx as not retryable', () => {
    expect(classifyOutcome({ status: 201 })).toBe(false)
  })
})

describe('backoffDelay', () => {
  it('stays inside the ceiling for each attempt', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60000, factor: 2 }
    expect(backoffDelay(1, opts, () => 0.99)).toBeLessThanOrEqual(1000)
    expect(backoffDelay(2, opts, () => 0.99)).toBeLessThanOrEqual(2000)
    expect(backoffDelay(3, opts, () => 0.99)).toBeLessThanOrEqual(4000)
  })

  it('is capped at maxDelayMs', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 5000, factor: 2 }
    expect(backoffDelay(10, opts, () => 0.99)).toBeLessThanOrEqual(5000)
  })

  it('applies full jitter: zero random gives zero delay', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60000, factor: 2 }
    expect(backoffDelay(3, opts, () => 0)).toBe(0)
  })
})

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000)
    expect(parseRetryAfter('garbage', 0)).toBeUndefined()
    expect(parseRetryAfter(null, 0)).toBeUndefined()
  })
})

describe('createOutbox', () => {
  it('sends a queued item with the bearer token and acks on 2xx', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 201 }])
    const outbox = makeOutbox({
      fetch,
      now: () => 0,
      headersFor: () => ({ authorization: 'Bearer secret-token' }),
    })
    await enqueueCapture(outbox)
    const result = await outbox.drain()
    expect(result.sent).toBe(1)
    expect(result.pending).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(ENDPOINTS.capture)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer secret-token')
    expect(headers['content-type']).toBe('application/json')
    expect(outbox.items()).toHaveLength(0)
  })

  it('routes ingest items to the ingest endpoint', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200 }])
    const outbox = makeOutbox({ fetch, now: () => 0 })
    await outbox.enqueue({
      idempotencyKey: 'ingest:abc',
      kind: 'ingest',
      url: 'https://example.com +3',
      payload: '{"kind":"urls","urls":["https://example.com"]}',
    })
    await outbox.drain()
    expect(calls[0]?.url).toBe(ENDPOINTS.ingest)
  })

  it('persists items across "browser restarts" (a new instance, same storage)', async () => {
    const storage = memoryStorage()
    const { fetch, calls } = scriptedFetch([{ throws: true }, { status: 201 }])
    let nowMs = 0
    const first = makeOutbox({ storage, fetch, now: () => nowMs })
    await enqueueCapture(first)
    await first.drain()
    expect(first.items()).toHaveLength(1)

    // "Restart": a brand new outbox over the same storage picks the item up.
    const second = makeOutbox({ storage, fetch, now: () => nowMs })
    await second.ready
    expect(second.items()).toHaveLength(1)
    expect(second.items()[0]?.attempts).toBe(1)

    nowMs = 60_000
    const result = await second.drain()
    expect(result.sent).toBe(1)
    expect(calls).toHaveLength(2)
    expect(second.items()).toHaveLength(0)
  })

  it('dedupes enqueue by idempotency key', async () => {
    const outbox = makeOutbox({ now: () => 0 })
    const first = await enqueueCapture(outbox)
    const second = await enqueueCapture(outbox)
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(true)
    expect(second.duplicate).toBe(true)
    expect(outbox.items()).toHaveLength(1)
  })

  it('keeps a payload queued when the fetch throws', async () => {
    const { fetch } = scriptedFetch([{ throws: true }])
    const outbox = makeOutbox({ fetch, now: () => 0 })
    await enqueueCapture(outbox)
    const result = await outbox.drain()
    expect(result.sent).toBe(0)
    expect(result.pending).toBe(1)
    expect(result.failed).toBe(0)
    expect(outbox.items()[0]?.attempts).toBe(1)
  })

  it('dead-letters after the maximum number of attempts', async () => {
    const { fetch, calls } = scriptedFetch([{ throws: true }])
    const outbox = makeOutbox({ fetch, now: () => 0, maxAttempts: 3 })
    await enqueueCapture(outbox)
    await outbox.drain()
    await outbox.drain()
    await outbox.drain()
    expect(calls).toHaveLength(3)
    expect(outbox.items()).toHaveLength(0)
    expect(outbox.deadItems()).toHaveLength(1)
    expect(outbox.deadItems()[0]?.lastError).toContain('gave up')
  })

  it('dead-letters a 401 without retrying it, keeping the error', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 401 }])
    const outbox = makeOutbox({ fetch, now: () => 0 })
    await enqueueCapture(outbox)
    const result = await outbox.drain()
    expect(result.failed).toBe(1)
    expect(result.pending).toBe(0)
    expect(calls).toHaveLength(1)
    expect(outbox.deadItems()[0]?.lastError).toBe('HTTP 401')
  })

  it('dead-letters a 403 (capture endpoint disabled) and a 400', async () => {
    for (const status of [403, 400]) {
      const { fetch } = scriptedFetch([{ status }])
      const outbox = makeOutbox({ fetch, now: () => 0 })
      await enqueueCapture(outbox, `capture:key-${status}`)
      const result = await outbox.drain()
      expect(result.failed).toBe(1)
      expect(outbox.deadItems()).toHaveLength(1)
    }
  })

  it('keeps a 500 item queued for a later attempt', async () => {
    const { fetch } = scriptedFetch([{ status: 500 }])
    const outbox = makeOutbox({ fetch, now: () => 0 })
    await enqueueCapture(outbox)
    const result = await outbox.drain()
    expect(result.failed).toBe(0)
    expect(result.pending).toBe(1)
    expect(outbox.items()[0]?.dead).toBeUndefined()
  })

  it('retries a 429 and honours Retry-After over the jittered backoff', async () => {
    let nowMs = 0
    const { fetch, calls } = scriptedFetch([{ status: 429, retryAfter: '30' }, { status: 201 }])
    const outbox = makeOutbox({ fetch, now: () => nowMs, random: () => 0 })
    await enqueueCapture(outbox)
    await outbox.drain()
    expect(calls).toHaveLength(1)
    expect(outbox.items()).toHaveLength(1)
    // Retry-After 30s wins over the ~1s jittered backoff.
    nowMs = 29_000
    await outbox.drain()
    expect(calls).toHaveLength(1)
    nowMs = 30_000
    await outbox.drain()
    expect(calls).toHaveLength(2)
    expect(outbox.items()).toHaveLength(0)
  })

  it('refuses an enqueue past the live queue cap', async () => {
    const outbox = makeOutbox({ maxSize: 2, now: () => 0 })
    await outbox.enqueue({ idempotencyKey: 'k1', kind: 'capture', url: 'u1', payload: '{}' })
    await outbox.enqueue({ idempotencyKey: 'k2', kind: 'capture', url: 'u2', payload: '{}' })
    const third = await outbox.enqueue({
      idempotencyKey: 'k3',
      kind: 'capture',
      url: 'u3',
      payload: '{}',
    })
    expect(third.accepted).toBe(false)
    expect(third.reason).toBe('queue_full')
  })

  it('does not attempt an item before its backoff has elapsed', async () => {
    let nowMs = 0
    const { fetch, calls } = scriptedFetch([{ throws: true }])
    const outbox = makeOutbox({ fetch, now: () => nowMs, random: () => 0.5, baseDelayMs: 1000 })
    await enqueueCapture(outbox)
    await outbox.drain()
    expect(calls).toHaveLength(1)
    nowMs = 100
    await outbox.drain()
    expect(calls).toHaveLength(1)
    nowMs = 5000
    await outbox.drain()
    expect(calls).toHaveLength(2)
  })

  it('reports the time until the next attempt', async () => {
    let nowMs = 0
    const { fetch } = scriptedFetch([{ throws: true }])
    const outbox = makeOutbox({ fetch, now: () => nowMs, random: () => 0.5, baseDelayMs: 1000 })
    await enqueueCapture(outbox)
    const result = await outbox.drain()
    expect(result.nextAttemptInMs).toBe(500)
    nowMs = 100
    const later = await outbox.drain()
    expect(later.nextAttemptInMs).toBe(400)
  })

  it('clearDead drops dead-lettered items only', async () => {
    const storage = memoryStorage()
    const { fetch } = scriptedFetch([{ status: 401 }, { throws: true }])
    const outbox = makeOutbox({ storage, fetch, now: () => 0 })
    await outbox.enqueue({ idempotencyKey: 'dead', kind: 'capture', url: 'u', payload: '{}' })
    await outbox.enqueue({
      idempotencyKey: 'live',
      kind: 'capture',
      url: 'u2',
      payload: '{}',
    })
    await outbox.drain()
    expect(outbox.deadItems()).toHaveLength(1)
    expect(await outbox.clearDead()).toBe(1)
    expect(outbox.deadItems()).toHaveLength(0)
    expect(outbox.items()).toHaveLength(1)
  })

  it('revives a dead-lettered item when the same key is re-enqueued', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 401 }, { status: 201 }])
    const outbox = makeOutbox({ fetch, now: () => 0 })
    await enqueueCapture(outbox)
    await outbox.drain()
    expect(outbox.deadItems()).toHaveLength(1)

    // The user re-captures the same page: same key, fresh payload.
    const revived = await outbox.enqueue({
      idempotencyKey: 'capture:https://example.com/a:2026-01-01T00:00:00.000Z',
      kind: 'capture',
      url: 'https://example.com/a',
      payload: '{"url":"https://example.com/a","body":"newer"}',
    })
    expect(revived.accepted).toBe(true)
    expect(revived.revived).toBe(true)
    expect(revived.duplicate).toBeUndefined()
    expect(outbox.deadItems()).toHaveLength(0)
    expect(outbox.items()).toHaveLength(1)
    expect(outbox.items()[0]?.attempts).toBe(0)
    expect(outbox.items()[0]?.payload).toContain('newer')

    // And it is retried, not stuck dead.
    const result = await outbox.drain()
    expect(result.sent).toBe(1)
    expect(calls).toHaveLength(2)
    expect(outbox.items()).toHaveLength(0)
  })

  it('still dedupes a re-enqueue against a LIVE item', async () => {
    const { fetch, calls } = scriptedFetch([{ throws: true }])
    const outbox = makeOutbox({ fetch, now: () => 0 })
    await enqueueCapture(outbox)
    await outbox.drain() // fails retryable, stays live
    const again = await enqueueCapture(outbox)
    expect(again.accepted).toBe(true)
    expect(again.duplicate).toBe(true)
    expect(again.revived).toBeUndefined()
    expect(outbox.items()).toHaveLength(1)
    expect(calls).toHaveLength(1) // no extra send happened
  })

  it('removes an acked item from storage, not just memory', async () => {
    const storage = memoryStorage()
    const outbox = makeOutbox({ storage, fetch: async () => new Response('', { status: 200 }), now: () => 0 })
    await enqueueCapture(outbox)
    await outbox.drain()
    const stored = storage.data.get('atento:outbox') as unknown[]
    expect(stored).toHaveLength(0)
  })
})
