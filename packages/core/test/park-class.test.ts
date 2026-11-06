/**
 * The extract stage parks every link it cannot read with a reason class:
 * a login wall, a bot block, a JS shell, an http error or a timeout. The
 * class travels in the state payload, so the overview can break the parked
 * links down by reason.
 *
 * Everything is offline: a fake clock, a fake extract fn, an in-memory
 * store. Nothing sleeps and nothing touches the network.
 */
import { describe, expect, it } from 'vitest'
import { FakeStore } from './fake-store.js'
import {
  DEFAULT_LIMITS,
  extract,
  guardDepsFromStore,
  pipelineOverview,
  type ExtractFn,
  type Link,
} from '../src/index.js'
import { normalizeUrl } from '../src/url.js'

function fakeClock(start = 3_000_000) {
  let now = start
  return {
    now: () => new Date(now),
    ms: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

async function insertLinks(store: FakeStore, urls: string[]): Promise<Link[]> {
  const links: Link[] = []
  for (const url of urls) {
    const { url: normalized, hash } = normalizeUrl(url)
    links.push(
      await store.upsertLink({
        urlHash: hash,
        url: normalized,
        source: 'test',
        status: 'inbox',
        needsBrowser: false,
      }),
    )
  }
  return links
}

const UNLIMITED = {
  ...DEFAULT_LIMITS,
  walledGardens: [],
  skipHosts: [],
  hosts: {
    'example.com': { intervalMs: 0, concurrency: 100 },
    'shell.example': { intervalMs: 0, concurrency: 100 },
    'block.example': { intervalMs: 0, concurrency: 100 },
    'broken.example': { intervalMs: 0, concurrency: 100 },
    'slow.example': { intervalMs: 0, concurrency: 100 },
  },
}

function guard(store: FakeStore, clock: ReturnType<typeof fakeClock>) {
  return guardDepsFromStore(store, {
    clock: () => clock.ms(),
    random: () => 0,
    sleep: async () => {},
    config: { limits: UNLIMITED },
  })
}

/** The class the parked link carries. */
async function classOf(store: FakeStore, linkId: number): Promise<string | undefined> {
  const state = await store.getState(linkId)
  return state && state.state === 'needs_browser' ? state.reasonClass : undefined
}

describe('the extract stage parks with a reason class', () => {
  it('parks a login wall with the login_wall class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://gated.example/post'])
    const extractFn: ExtractFn = async () => ({
      markdown: 'Sign in to continue',
      extractor: 'defuddle',
      status: 401,
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    expect(await classOf(store, link!.id)).toBe('login_wall')
  })

  it('parks a bot block with the bot_block class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://block.example/post'])
    // A bare 429 refusal: the host rate-limited the client outright, no
    // session would help.
    const extractFn: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      extractor: 'defuddle',
      status: 429,
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    expect(await classOf(store, link!.id)).toBe('bot_block')
  })

  it('parks a captcha page with the bot_block class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://block.example/captcha'])
    const extractFn: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      extractor: 'browser',
      html: '<html><body>Please complete the captcha</body></html>',
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    expect(await classOf(store, link!.id)).toBe('bot_block')
  })

  it('parks a JS shell with the js_shell class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://shell.example/post'])
    const extractFn: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      extractor: 'defuddle',
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    expect(await classOf(store, link!.id)).toBe('js_shell')
  })

  it('parks an error page with the http_error class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://broken.example/post'])
    const extractFn: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      extractor: 'defuddle',
      status: 500,
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    expect(await classOf(store, link!.id)).toBe('http_error')
  })

  it('parks a timed out request with the timeout class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://slow.example/post'])
    const extractFn: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      extractor: 'defuddle',
      error: 'the request timed out',
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    expect(await classOf(store, link!.id)).toBe('timeout')
  })

  it('parks a review-only link with the review_only class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://example.com/post'])
    const extractFn: ExtractFn = async () => {
      throw new Error('must never be called')
    }
    await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: {
          limits: {
            ...UNLIMITED,
            reviewHosts: ['example.com'],
          },
        },
      }),
      now: clock.now,
    })
    expect(await classOf(store, link!.id)).toBe('review_only')
  })

  it('defers a blocked link with the class of the block', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://block.example/post'])
    const extractFn: ExtractFn = async () => ({
      markdown: '',
      blocked: true,
      blockReason: 'bot_block',
      extractor: 'browser',
    })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    const state = await store.getState(link!.id)
    expect(state?.state).toBe('deferred')
    expect(state && state.state === 'deferred' ? state.reasonClass : undefined).toBe('bot_block')
  })

  it('counts the parked links by class in the overview', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, [
      'https://gated.example/post',
      'https://block.example/post',
      'https://shell.example/post',
    ])
    const outcomes: Record<string, ExtractFn> = {
      'gated.example': async () => ({ markdown: 'Sign in to continue', status: 401, extractor: 'd' }),
      'block.example': async () => ({ markdown: '', needsBrowser: true, status: 429, extractor: 'd' }),
      'shell.example': async () => ({ markdown: '', needsBrowser: true, extractor: 'd' }),
    }
    const extractFn: ExtractFn = async (url) => {
      const host = new URL(url).hostname
      return outcomes[host]!(url)
    }
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    const overview = await pipelineOverview(store)
    expect(overview.byParkReason.login_wall).toBe(1)
    expect(overview.byParkReason.bot_block).toBe(1)
    expect(overview.byParkReason.js_shell).toBe(1)
    expect(overview.byParkReason.unknown).toBe(0)
  })

  it('stamps the legacy parked rows with the unknown class', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://legacy.example/post'])
    // A row parked before the classes existed: no reason at all.
    await store.applyEvent(link!.id, {
      type: 'EXTRACT_STARTED',
      at: new Date(0).toISOString(),
    })
    await store.applyEvent(link!.id, {
      type: 'NEEDS_BROWSER',
      host: 'legacy.example',
      at: new Date(0).toISOString(),
    })
    const before = await store.getState(link!.id)
    expect(before && before.state === 'needs_browser' ? before.reasonClass : undefined).toBe('unknown')

    // The next extract run stamps it explicitly.
    await insertLinks(store, ['https://example.com/other'])
    const extractFn: ExtractFn = async () => ({ markdown: 'real content', extractor: 'd' })
    await extract(store, { extract: extractFn, guard: guard(store, clock), now: clock.now })
    const after = await store.getState(link!.id)
    expect(after && after.state === 'needs_browser' ? after.reasonClass : undefined).toBe('unknown')
  })
})
