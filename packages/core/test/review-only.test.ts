/**
 * Review-only hosts: links the pipeline never fetches and never logs in to,
 * parked in needs_browser with the reason review_only so the owner reads
 * them by hand. Plus the reconcile sweep that moves already-parked links to
 * the state the current policy asks for.
 *
 * Everything is offline: fake clock, fake extract fn, in-memory store.
 */
import { describe, expect, it } from 'vitest'
import { FakeStore } from './fake-store.js'
import {
  DEFAULT_LIMITS,
  emptyHostState,
  extract,
  guardDepsFromStore,
  reconcileParkedLinks,
  type ExtractFn,
  type Link,
} from '../src/index.js'
import { normalizeUrl } from '../src/url.js'

function fakeClock(start = 2_000_000) {
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
  hosts: { 'revolut.com': { intervalMs: 0, concurrency: 100 } },
}

const noFetch: ExtractFn = async () => {
  throw new Error('must never be called')
}

function guard(store: FakeStore, clock: ReturnType<typeof fakeClock>, limits = UNLIMITED) {
  return guardDepsFromStore(store, {
    clock: () => clock.ms(),
    random: () => 0,
    sleep: async () => {},
    config: { limits, login: { allow: ['app.devin.ai'] } },
  })
}

describe('review_hosts short-circuit', () => {
  it('parks review-listed links in needs_browser without a fetch', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, [
      'https://revolut.com/revolvewithcarolyn',
      'https://www.revolut.com/help',
    ])
    const result = await extract(store, {
      extract: noFetch,
      guard: guard(store, clock, { ...UNLIMITED, reviewHosts: ['revolut.com', '*.revolut.com'] }),
      now: clock.now,
    })
    const states = await store.listByStates(['needs_browser'])
    expect(states).toHaveLength(2)
    for (const link of states) {
      expect(link.stateData?.['reason']).toBe('review_only')
      expect(link.expiryReason).toBe('review_only')
    }
    expect(result.reviewOnlyCount).toBe(2)
    expect(result.needsBrowserCount).toBe(2)
    expect(result.errorCount).toBe(0)
  })

  it('review hosts win over a saved profile and the login gate', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await store.upsertProfile({ host: 'revolut.com', path: '/profiles/revolut.com' })
    await insertLinks(store, ['https://revolut.com/private'])
    await extract(store, {
      extract: noFetch,
      guard: guard(store, clock, { ...UNLIMITED, reviewHosts: ['revolut.com'] }),
      now: clock.now,
    })
    const parked = await store.listByStates(['needs_browser'])
    expect(parked).toHaveLength(1)
    expect(parked[0]?.stateData?.['reason']).toBe('review_only')
  })

  it('unlisted hosts are not touched by the review branch', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, ['https://example.com/post'])
    let calls = 0
    const result = await extract(store, {
      extract: async (url) => {
        calls += 1
        return { markdown: `content ${url}`, extractor: 'defuddle' }
      },
      guard: guard(store, clock, { ...UNLIMITED, reviewHosts: ['revolut.com'] }),
      now: clock.now,
    })
    expect(calls).toBe(1)
    expect(result.reviewOnlyCount).toBe(0)
    expect((await store.listByStates(['extracted']))).toHaveLength(1)
  })
})

describe('the [login] allow list gates the login-walled hosts', () => {
  it('a login-gated host outside the allow list is parked review-only without a fetch', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, ['https://revolut.com/private'])
    // The host answered with a login wall before: it is known to be gated.
    await store.saveHostState({
      ...emptyHostState('revolut.com'),
      key: 'revolut.com',
      trialState: 'flagged',
      trialReason: 'login_wall',
      trialAt: clock.ms(),
      loginGated: true,
    })
    const result = await extract(store, {
      extract: noFetch,
      guard: guard(store, clock),
      now: clock.now,
    })
    expect(result.reviewOnlyCount).toBe(1)
    const parked = await store.listByStates(['needs_browser'])
    expect(parked[0]?.stateData?.['reason']).toBe('review_only')
  })

  it('the first link of a non-allowed login-walled host parks review-only right away', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, ['https://revolut.com/private'])
    let calls = 0
    const result = await extract(store, {
      extract: async () => {
        calls += 1
        return { markdown: 'Sign in to continue', extractor: 'defuddle', status: 401 }
      },
      guard: guard(store, clock),
      now: clock.now,
    })
    // The wall was seen, so the host is known to be login-gated, and the
    // allow list does not cover it: the link is review-only from the start.
    expect(calls).toBe(1)
    expect(result.reviewOnlyCount).toBe(1)
    const parked = await store.listByStates(['needs_browser'])
    expect(parked[0]?.stateData?.['reason']).toBe('review_only')
    expect(parked[0]?.expiryReason).toBe('review_only')
  })

  it('a host in the allow list keeps the ordinary login flow (fetch attempted)', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, ['https://app.devin.ai/session/1'])
    let calls = 0
    const result = await extract(store, {
      extract: async () => {
        calls += 1
        return { markdown: 'Sign in to continue', extractor: 'defuddle', status: 401 }
      },
      guard: guard(store, clock),
      now: clock.now,
    })
    expect(calls).toBe(1)
    expect(result.needsBrowserCount).toBe(1)
    const parked = await store.listByStates(['needs_browser'])
    expect(parked[0]?.stateData?.['reason']).toBe('login_wall')
  })

  it('a saved profile overrides the allow list', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await store.upsertProfile({ host: 'x.com', path: '/profiles/x.com' })
    await insertLinks(store, ['https://x.com/post/1'])
    let calls = 0
    await extract(store, {
      extract: async () => {
        calls += 1
        return { markdown: 'Sign in to continue', extractor: 'defuddle', status: 401 }
      },
      guard: guard(store, clock),
      now: clock.now,
    })
    // The fetch was attempted: the profile counts as allowed.
    expect(calls).toBe(1)
    const parked = await store.listByStates(['needs_browser'])
    expect(parked[0]?.stateData?.['reason']).toBe('login_wall')
  })

  it('an empty allow list keeps the old behaviour for every host', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    await insertLinks(store, ['https://walled.example/private'])
    let calls = 0
    const result = await extract(store, {
      extract: async () => {
        calls += 1
        return { markdown: 'Sign in to continue', extractor: 'defuddle', status: 401 }
      },
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        // No login config at all: the default (no restriction).
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    expect(calls).toBe(1)
    expect(result.needsBrowserCount).toBe(1)
  })
})

describe('the reconcile sweep', () => {
  /** Park a link in needs_browser the way the extract stage does. */
  async function park(store: FakeStore, link: Link, reason = 'login_wall'): Promise<void> {
    await store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date(0).toISOString() })
    await store.applyEvent(link.id, {
      type: 'NEEDS_BROWSER',
      host: new URL(link.url).hostname,
      reason,
      at: new Date(0).toISOString(),
    })
  }

  it('moves parked links of a now skip-listed host to discarded', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://gemini.google.com/app'])
    await park(store, link!)
    const result = await reconcileParkedLinks(store, {
      limits: { ...UNLIMITED, skipHosts: ['gemini.google.com'] },
      now: clock.now(),
    })
    expect(result.discarded).toBe(1)
    expect(await store.listByStates(['needs_browser'])).toHaveLength(0)
    const discarded = await store.listByStates(['discarded'])
    expect(discarded).toHaveLength(1)
    expect(discarded[0]?.expiryReason).toBe('skip_host')
  })

  it('rewrites the parked reason of a now review-only host', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://revolut.com/private'])
    await park(store, link!)
    const result = await reconcileParkedLinks(store, {
      limits: { ...UNLIMITED, reviewHosts: ['revolut.com'] },
      now: clock.now(),
    })
    expect(result.reviewOnly).toBe(1)
    const parked = await store.listByStates(['needs_browser'])
    expect(parked).toHaveLength(1)
    expect(parked[0]?.stateData?.['reason']).toBe('review_only')
    expect(parked[0]?.expiryReason).toBe('review_only')
  })

  it('is idempotent: a second sweep changes nothing', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [a] = await insertLinks(store, ['https://gemini.google.com/app'])
    const [b] = await insertLinks(store, ['https://revolut.com/private'])
    await park(store, a!)
    await park(store, b!)
    const first = await reconcileParkedLinks(store, {
      limits: { ...UNLIMITED, skipHosts: ['gemini.google.com'], reviewHosts: ['revolut.com'] },
      now: clock.now(),
    })
    expect(first.discarded).toBe(1)
    expect(first.reviewOnly).toBe(1)
    const second = await reconcileParkedLinks(store, {
      limits: { ...UNLIMITED, skipHosts: ['gemini.google.com'], reviewHosts: ['revolut.com'] },
      now: clock.now(),
    })
    expect(second.discarded).toBe(0)
    expect(second.reviewOnly).toBe(0)
    expect(await store.listByStates(['needs_browser'])).toHaveLength(1)
    expect(await store.listByStates(['discarded'])).toHaveLength(1)
  })

  it('leaves parked links of ordinary hosts alone', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://x.com/post/1'])
    await park(store, link!)
    const result = await reconcileParkedLinks(store, {
      limits: { ...UNLIMITED, reviewHosts: ['revolut.com'] },
      loginAllow: ['app.devin.ai'],
      now: clock.now(),
    })
    expect(result.discarded).toBe(0)
    expect(result.reviewOnly).toBe(0)
    const parked = await store.listByStates(['needs_browser'])
    expect(parked[0]?.stateData?.['reason']).toBe('login_wall')
  })

  it('runs at the start of an extract run with a metric row', async () => {
    const store = new FakeStore()
    const clock = fakeClock()
    const [stale] = await insertLinks(store, ['https://localhost:3000/stale'])
    await park(store, stale!)
    // The link is parked on a host that is now skip-listed (loopback).
    await extract(store, {
      extract: noFetch,
      guard: guard(store, clock, UNLIMITED),
      now: clock.now,
    })
    const discarded = await store.listByStates(['discarded'])
    expect(discarded).toHaveLength(1)
    const metrics = await store.listMetrics()
    const reconciled = metrics.filter((m) => m.key === 'reconciled')
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]?.tags?.['discarded']).toBe('1')
  })
})
