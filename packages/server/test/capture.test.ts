/**
 * Capture endpoint contract tests: auth, CORS, size cap, dedupe, skip-extract
 * and trust order. Everything runs offline through hono's request API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@atento/db'
import { DEFAULT_CAPTURE_CONFIG, normalizeUrl } from '@atento/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

const TOKEN = 'test-token-1234'
const captureConfig = {
  ...DEFAULT_CAPTURE_CONFIG,
  allowedOrigins: ['chrome-extension://abcdef'],
}
const env = { ATENTO_CAPTURE_TOKEN: TOKEN }

function post(body: string | unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return createApp(store, { capture: captureConfig, env }).request('/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  })
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/article',
    title: 'An article',
    capturedAt: '2026-10-29T12:00:00.000Z',
    contentType: 'page',
    body: '# An article\n\nBody text.',
    source: 'stash',
    ...overrides,
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atento-capture-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /capture: auth', () => {
  it('401s without a bearer token', async () => {
    const res = await post(capture())
    expect(res.status).toBe(401)
  })

  it('401s with a wrong token and never echoes the configured one', async () => {
    const res = await post(capture(), { authorization: 'Bearer wrong' })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain(TOKEN)
  })

  it('403s when the token env var is unset (endpoint disabled)', async () => {
    const res = await createApp(store, { capture: captureConfig, env: {} }).request('/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(capture()),
    })
    expect(res.status).toBe(403)
  })

  it('201s with the right token and stores a captured link', async () => {
    const res = await post(capture(), { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; outcome: string }
    expect(body.outcome).toBe('created')
    const link = await store.getLink(body.id)
    expect(link?.captured).toBe(true)
    expect(link?.source).toBe('stash')
    expect(link?.state).toBe('extracted')
    expect(link?.extractedContent).toContain('Body text')
  })
})

describe('POST /capture: validation and size cap', () => {
  it('400s on invalid JSON', async () => {
    const res = await post('not json', { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(400)
  })

  it('400s on a schema violation (unknown contentType)', async () => {
    const res = await post(capture({ contentType: 'note' }), {
      authorization: `Bearer ${TOKEN}`,
    })
    expect(res.status).toBe(400)
  })

  it('413s over the body size cap', async () => {
    const res = await post(capture({ body: 'x'.repeat(3 * 1024 * 1024) }), {
      authorization: `Bearer ${TOKEN}`,
    })
    expect(res.status).toBe(413)
  })
})

describe('POST /capture: CORS', () => {
  it('echoes only configured origins', async () => {
    const allowed = await post(capture(), {
      authorization: `Bearer ${TOKEN}`,
      origin: 'chrome-extension://abcdef',
    })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdef')

    const denied = await post(capture(), {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://evil.example',
    })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers preflight with 204 for allowed origins', async () => {
    const app = createApp(store, { capture: captureConfig, env })
    const res = await app.request('/capture', {
      method: 'OPTIONS',
      headers: { origin: 'chrome-extension://abcdef' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdef')
  })
})

describe('POST /capture: dedupe and skip-extract', () => {
  it('dedupes by normalized url hash and reports the same link id', async () => {
    const first = await post(
      capture({ url: 'https://example.com/dedupe?utm_source=x' }),
      { authorization: `Bearer ${TOKEN}` },
    )
    const second = await post(capture({ url: 'https://example.com/dedupe' }), {
      authorization: `Bearer ${TOKEN}`,
    })
    const a = (await first.json()) as { id: number; outcome: string }
    const b = (await second.json()) as { id: number; outcome: string }
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('duplicate')
    expect(b.id).toBe(a.id)
  })

  it('a captured link is not picked up by the extract stage (skip-extract)', async () => {
    const res = await post(capture({ url: 'https://example.com/skip-extract' }), {
      authorization: `Bearer ${TOKEN}`,
    })
    const { id } = (await res.json()) as { id: number }
    const link = await store.getLink(id)
    // The link carries content already: extract only picks up `created`.
    expect(link?.state).toBe('extracted')
    expect(link?.captured).toBe(true)
    const created = await store.listByStates(['created'])
    expect(created.find((l) => l.id === id)).toBeUndefined()
  })

  it('a retried POST (timeout replay) is idempotent: one link, duplicate ack', async () => {
    // The client never saw the first ack and replays the identical payload:
    // url_hash + capturedAt dedupe must make the retry a no-op, and the ack
    // only ever describes committed state.
    const payload = capture({
      url: 'https://example.com/retry?utm_campaign=launch',
      capturedAt: '2026-10-30T09:00:00.000Z',
    })
    const first = await post(payload, { authorization: `Bearer ${TOKEN}` })
    const second = await post(payload, { authorization: `Bearer ${TOKEN}` })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { id: number; outcome: string }
    const b = (await second.json()) as { id: number; outcome: string }
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('duplicate')
    expect(b.id).toBe(a.id)
    // Exactly one link row exists for the normalized url.
    const { hash } = normalizeUrl(String(payload.url))
    const link = await store.getLinkByUrlHash(hash)
    expect(link?.id).toBe(a.id)
    expect(await store.countLinks({})).toBeGreaterThanOrEqual(1)
    const all = await store.listLinks({})
    expect(all.filter((l) => l.urlHash === hash)).toHaveLength(1)
    // The committed state is what the ack described.
    expect(link?.state).toBe('extracted')
    expect(link?.extractedContent).toContain('Body text')
    expect(link?.capturedAt?.toISOString()).toBe(String(payload.capturedAt))
  })
})

describe('POST /capture: trust order', () => {
  it('updates an anonymous-extracted link with a newer capture', async () => {
    // Seed a link the headless pipeline extracted anonymously (not captured).
    const { url, hash } = normalizeUrl('https://example.com/trust-anon')
    const seeded = await store.upsertLink({
      urlHash: hash,
      url,
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    await store.setExtractedContent(seeded.id, 'anonymous body', false, new Date('2026-01-01T00:00:00Z'))

    const res = await post(
      capture({ url, body: 'captured body', capturedAt: '2026-10-29T12:00:00.000Z' }),
      { authorization: `Bearer ${TOKEN}` },
    )
    const body = (await res.json()) as { id: number; outcome: string }
    expect(body.id).toBe(seeded.id)
    expect(body.outcome).toBe('updated')
    const link = await store.getLink(seeded.id)
    expect(link?.extractedContent).toBe('captured body')
    expect(link?.captured).toBe(true)
  })

  it('does not downgrade a newer captured link with an older capture', async () => {
    const { url, hash } = normalizeUrl('https://example.com/trust-new')
    const seeded = await store.upsertLink({
      urlHash: hash,
      url,
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    await store.setExtractedContent(seeded.id, 'newer captured body', false, new Date('2026-10-29T13:00:00Z'))
    await store.markCaptured(seeded.id, new Date('2026-10-29T13:00:00Z'))

    const res = await post(
      capture({ url, body: 'older capture', capturedAt: '2026-10-29T10:00:00.000Z' }),
      { authorization: `Bearer ${TOKEN}` },
    )
    const body = (await res.json()) as { outcome: string }
    expect(body.outcome).toBe('duplicate')
    expect((await store.getLink(seeded.id))?.extractedContent).toBe('newer captured body')
  })

  it('never updates an enriched link from an equal-trust capture', async () => {
    const { url, hash } = normalizeUrl('https://example.com/trust-enriched')
    const seeded = await store.upsertLink({
      urlHash: hash,
      url,
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    await store.setExtractedContent(seeded.id, 'already enriched content', false, new Date('2026-10-29T13:00:00Z'))
    await store.markCaptured(seeded.id, new Date('2026-10-29T13:00:00Z'))

    const res = await post(
      capture({ url, body: 'equal trust newer', capturedAt: '2026-10-29T14:00:00.000Z' }),
      { authorization: `Bearer ${TOKEN}` },
    )
    const body = (await res.json()) as { outcome: string }
    // Same trust tier, non-empty content: no clobber.
    expect(body.outcome).toBe('duplicate')
  })

  it('fills empty content on a known link regardless of trust', async () => {
    const { url, hash } = normalizeUrl('https://example.com/trust-empty')
    const seeded = await store.upsertLink({
      urlHash: hash,
      url,
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    // No extractedContent at all.
    const res = await post(
      capture({ url, body: 'first content ever', capturedAt: '2026-10-29T12:00:00.000Z' }),
      { authorization: `Bearer ${TOKEN}` },
    )
    const body = (await res.json()) as { id: number; outcome: string }
    expect(body.id).toBe(seeded.id)
    expect(body.outcome).toBe('updated')
    expect((await store.getLink(seeded.id))?.extractedContent).toBe('first content ever')
  })
})
