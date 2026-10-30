import { describe, expect, it } from 'vitest'
import {
  backoffDelay,
  classifyOutcome,
  createCaptureQueue,
  type FetchLike,
} from '../src/queue.js'

/** A scripted fetch: every call pops the next scripted response. */
function scriptedFetch(
  responses: { status?: number; throws?: boolean }[],
): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  let index = 0
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (!next) throw new Error('no scripted response')
    if (next.throws === true) throw new Error('fetch failed')
    return new Response(JSON.stringify({ outcome: 'created', id: 1 }), {
      status: next.status ?? 201,
    })
  }
  return { fetch, calls }
}

describe('classifyOutcome', () => {
  it('treats network errors as retryable', () => {
    expect(classifyOutcome({ error: 'fetch failed' })).toBe(true)
  })

  it('treats 408, 425 and 5xx as retryable', () => {
    expect(classifyOutcome({ status: 408 })).toBe(true)
    expect(classifyOutcome({ status: 425 })).toBe(true)
    expect(classifyOutcome({ status: 500 })).toBe(true)
    expect(classifyOutcome({ status: 503 })).toBe(true)
  })

  it('treats 401, 403 and 400 as not retryable', () => {
    expect(classifyOutcome({ status: 401 })).toBe(false)
    expect(classifyOutcome({ status: 403 })).toBe(false)
    expect(classifyOutcome({ status: 400 })).toBe(false)
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

describe('createCaptureQueue', () => {
  it('sends a queued payload with the bearer token', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 201 }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 'secret-token',
      fetch,
      now: () => 0,
      random: () => 0,
    })
    queue.enqueue('https://example.com/a', '{"url":"https://example.com/a"}')
    const result = await queue.drain()
    expect(result.sent).toBe(1)
    expect(result.pending).toBe(0)
    expect(calls).toHaveLength(1)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer secret-token')
    expect(headers['content-type']).toBe('application/json')
    expect(calls[0]?.init.method).toBe('POST')
  })

  it('keeps a payload queued when the fetch throws', async () => {
    const { fetch } = scriptedFetch([{ throws: true }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch,
      now: () => 0,
      random: () => 0,
    })
    queue.enqueue('https://example.com/a', '{}')
    const result = await queue.drain()
    expect(result.sent).toBe(0)
    expect(result.pending).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('gives up after the maximum number of attempts', async () => {
    const { fetch, calls } = scriptedFetch([{ throws: true }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch,
      now: () => 0,
      random: () => 0,
      maxAttempts: 3,
    })
    queue.enqueue('https://example.com/a', '{}')
    await queue.drain()
    await queue.drain()
    await queue.drain()
    expect(calls).toHaveLength(3)
    expect(queue.size()).toBe(0)
  })

  it('drops a payload on a 401 without retrying it', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 401 }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 'wrong',
      fetch,
      now: () => 0,
      random: () => 0,
    })
    queue.enqueue('https://example.com/a', '{}')
    const result = await queue.drain()
    expect(result.failed).toBe(1)
    expect(result.pending).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('drops a payload on a 403 (capture endpoint disabled)', async () => {
    const { fetch } = scriptedFetch([{ status: 403 }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch,
      now: () => 0,
      random: () => 0,
    })
    queue.enqueue('https://example.com/a', '{}')
    const result = await queue.drain()
    expect(result.failed).toBe(1)
    expect(result.pending).toBe(0)
  })

  it('keeps a 500 payload queued for a later attempt', async () => {
    const { fetch } = scriptedFetch([{ status: 500 }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch,
      now: () => 0,
      random: () => 0,
    })
    queue.enqueue('https://example.com/a', '{}')
    const result = await queue.drain()
    expect(result.failed).toBe(0)
    expect(result.pending).toBe(1)
  })

  it('refuses an enqueue past the queue cap', () => {
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch: async () => new Response('', { status: 201 }),
      now: () => 0,
      random: () => 0,
      maxSize: 2,
    })
    expect(queue.enqueue('https://example.com/a', '{}').accepted).toBe(true)
    expect(queue.enqueue('https://example.com/b', '{}').accepted).toBe(true)
    const third = queue.enqueue('https://example.com/c', '{}')
    expect(third.accepted).toBe(false)
    expect(third.reason).toBe('queue_full')
    expect(queue.size()).toBe(2)
  })

  it('does not attempt a payload before its backoff has elapsed', async () => {
    let nowMs = 0
    const { fetch, calls } = scriptedFetch([{ throws: true }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch,
      now: () => nowMs,
      // Half of the ceiling: the first backoff is 500ms.
      random: () => 0.5,
      baseDelayMs: 1000,
    })
    queue.enqueue('https://example.com/a', '{}')
    await queue.drain()
    expect(calls).toHaveLength(1)
    nowMs = 100
    await queue.drain()
    expect(calls).toHaveLength(1)
    nowMs = 5000
    await queue.drain()
    expect(calls).toHaveLength(2)
  })

  it('reports the time until the next attempt', async () => {
    let nowMs = 0
    const { fetch } = scriptedFetch([{ throws: true }])
    const queue = createCaptureQueue({
      endpoint: 'http://127.0.0.1:4173/capture',
      token: 't',
      fetch,
      now: () => nowMs,
      random: () => 0.5,
      baseDelayMs: 1000,
    })
    queue.enqueue('https://example.com/a', '{}')
    const result = await queue.drain()
    expect(result.nextAttemptInMs).toBe(500)
    nowMs = 100
    const later = await queue.drain()
    expect(later.nextAttemptInMs).toBe(400)
  })
})
