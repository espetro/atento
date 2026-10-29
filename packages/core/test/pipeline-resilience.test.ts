/**
 * Pipeline resilience integration: fake clock, fake fetch/enrich, real FSM.
 * A guard is built over a temp store so limiter and breaker state round-trips
 * through the host_state table like two separate CLI processes.
 */
import { describe, expect, it } from 'vitest'
import { FakeStore } from './fake-store.js'
import {
  extract,
  enrich,
  guardDepsFromStore,
  listHostsNeedingLogin,
  releaseDueDeferred,
  attemptsOf,
  WALLED_GARDEN_LIMIT,
  DEFAULT_LIMITS,
  LLM_KEY,
} from '../src/index.js'
import type { ExtractFn, EnrichFn, Link } from '../src/index.js'

function fakeClock(start = 1_000_000) {
  let now = start
  return {
    now: () => new Date(now),
    ms: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

async function tempStore(): Promise<FakeStore> {
  return new FakeStore()
}

async function insertLinks(store: FakeStore, urls: string[]): Promise<Link[]> {
  const { normalizeUrl } = await import('../src/url.js')
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
  disabled: false,
  hosts: {
    'example.com': { intervalMs: 0, concurrency: 100 },
    'open.example': { intervalMs: 0, concurrency: 100 },
    'limited.example': { intervalMs: 0, concurrency: 100 },
    'sticky.example': { intervalMs: 0, concurrency: 100 },
    'gated.example': { intervalMs: 0, concurrency: 100 },
    'private.example': { intervalMs: 0, concurrency: 100 },
    'plain.example': { intervalMs: 0, concurrency: 100 },
    'walled.example': { intervalMs: 0, concurrency: 100 },
  },
}

describe('pipeline: block signal defers the rest of the host batch', () => {
  it('opens the breaker on 403 and defers remaining links of that host', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const links = await insertLinks(store, [
      'https://walled.example/a/1',
      'https://walled.example/a/2',
      'https://walled.example/a/3',
    ])
    let calls = 0
    const extractFn: ExtractFn = async () => {
      calls += 1
      throw Object.assign(new Error('forbidden'), { status: 403 })
    }
    const result = await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })

    // Only one real fetch went out: the canary. The breaker opened, the host
    // was flagged and the rest deferred without another request.
    expect(calls).toBe(1)
    expect(result.deferredCount).toBe(3)
    expect(result.okCount).toBe(0)
    for (const link of links) {
      const state = await store.getState(link.id)
      expect(state?.state).toBe('deferred')
    }
    // The breaker is open and persisted, and the host is flagged.
    const hostState = await store.getHostState('walled.example')
    expect(hostState?.breakerState).toBe('open')
    expect(hostState?.trialState).toBe('flagged')
  })

  it('canary success then the remaining links proceed', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    await insertLinks(store, [
      'https://open.example/1',
      'https://open.example/2',
    ])
    let calls = 0
    const extractFn: ExtractFn = async (url) => {
      calls += 1
      return { markdown: `content for ${url}`, extractor: 'defuddle' }
    }
    const result = await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    expect(calls).toBe(2)
    expect(result.okCount).toBe(2)
    expect(result.deferredCount).toBe(0)
    const hostState = await store.getHostState('open.example')
    expect(hostState?.trialState).toBe('open')
  })

  it('canary rate limited then 99 deferred and only 1 request made', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const links = await insertLinks(store,
      Array.from({ length: 100 }, (_, i) => `https://limited.example/p/${i}`),
    )
    let calls = 0
    const extractFn: ExtractFn = async () => {
      calls += 1
      throw Object.assign(new Error('slow down'), { status: 429 })
    }
    const result = await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
      maxBatch: 500,
    })
    expect(calls).toBe(1)
    expect(result.deferredCount).toBe(100)
    for (const link of links.slice(1)) {
      const state = await store.getState(link.id)
      expect(state?.state).toBe('deferred')
      if (state?.state === 'deferred') {
        expect(state.reason).toContain('canary_flagged')
      }
    }
    const hostState = await store.getHostState('limited.example')
    expect(hostState?.trialState).toBe('flagged')
  })

  it('a flagged host stays flagged across a restart (persisted trial state)', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const [first] = await insertLinks(store, ['https://sticky.example/1'])
    const failing: ExtractFn = async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    }
    await extract(store, {
      extract: failing,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    expect((await store.getHostState('sticky.example'))?.trialState).toBe('flagged')

    // A new run (same store, like a restarted process): the next link is
    // deferred from the persisted flag without a fetch.
    await insertLinks(store, ['https://sticky.example/2'])
    let calls = 0
    const working: ExtractFn = async () => {
      calls += 1
      return { markdown: 'fine now', extractor: 'defuddle' }
    }
    // Advance past the flag ttl (24h), then release the deferred links (the
    // restart-time release loop). The expired flag means the host is
    // re-trialed and succeeds.
    clock.advance(25 * 60 * 60 * 1000)
    await releaseDueDeferred(store, 'extract', clock.now())
    const result = await extract(store, {
      extract: working,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    expect(calls).toBe(2)
    expect(result.okCount).toBe(2)
    expect((await store.getHostState('sticky.example'))?.trialState).toBe('open')
    void first
  })

  it('skip-listed hosts are parked as discarded without a fetch', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    await insertLinks(store, [
      'https://gemini.google.com/app',
      'https://gemini.google.com/share/x',
    ])
    let calls = 0
    const extractFn: ExtractFn = async () => {
      calls += 1
      return { markdown: 'nope', extractor: 'defuddle' }
    }
    const result = await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: {
          limits: { ...UNLIMITED, skipHosts: ['gemini.google.com'] },
        },
      }),
      now: clock.now,
    })
    expect(calls).toBe(0)
    expect(result.skippedHostCount).toBe(2)
    const states = await store.listByStates(['discarded'])
    expect(states).toHaveLength(2)
  })

  it('a 404 on a gated host is a private page, on an open host it is gone', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    // Gated host: a saved browser profile, so the 404 is a private page.
    await store.upsertProfile({ host: 'private.example', path: '/profiles/private.example' })
    const [gated] = await insertLinks(store, ['https://private.example/members-only'])
    const [open] = await insertLinks(store, ['https://plain.example/missing'])
    const extractFn: ExtractFn = async () => ({ markdown: '', gone: 404, extractor: 'defuddle' })
    const result = await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    const gatedState = await store.getState(gated.id)
    expect(gatedState?.state).toBe('needs_browser')
    const openState = await store.getState(open.id)
    expect(openState?.state).toBe('errored')
    expect(result.errorCount).toBe(1)
  })

  it('login walls park links in needs_browser with the login_wall reason and are listed', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://gated.example/post/1'])
    const extractFn: ExtractFn = async () => ({
      markdown: 'Sign in to continue',
      html: '<form><input type="password"></form>',
      finalUrl: 'https://gated.example/login?next=/post/1',
      extractor: 'defuddle',
    })
    const result = await extract(store, {
      extract: extractFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    expect(result.needsBrowserCount).toBe(1)
    const state = await store.getState(link.id)
    expect(state?.state).toBe('needs_browser')
    if (state?.state === 'needs_browser') expect(state.reason).toBe('login_wall')
    const hosts = await listHostsNeedingLogin(store)
    expect(hosts).toContainEqual(expect.objectContaining({ host: 'gated.example', reason: 'login_wall' }))
  })
})

describe('pipeline: deferred links wait for nextAttemptAt', () => {
  it('RETRY does not requeue before the wait elapses, and does after', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    await insertLinks(store, ['https://x.com/a/1'])
    let calls = 0
    const extractFn: ExtractFn = async () => {
      calls += 1
      return { markdown: `content ${calls}`, extractor: 'defuddle' }
    }
    const guard = guardDepsFromStore(store, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: { limits: UNLIMITED },
    })

    // First run: one link extracted.
    const first = await extract(store, {
      extract: extractFn,
      guard,
      now: clock.now,
    })
    expect(first.okCount).toBe(1)
    expect(calls).toBe(1)

    // Second run immediately after: spacing defers the next link.
    await insertLinks(store, ['https://x.com/a/2'])
    const second = await extract(store, {
      extract: extractFn,
      guard,
      now: clock.now,
    })
    expect(calls).toBe(1)
    expect(second.deferredCount).toBe(1)
    const deferred = (await store.listByStates(['deferred']))[0]
    expect(deferred).toBeDefined()

    // Before nextAttemptAt: nothing is released.
    const state = await store.getState(deferred!.id)
    if (state?.state !== 'deferred') throw new Error('expected deferred')
    const waitMs = new Date(state.nextAttemptAt).getTime() - clock.ms()
    const releasedEarly = await releaseDueDeferred(store, 'extract', clock.now())
    expect(releasedEarly).toBe(0)

    // After nextAttemptAt: the link is released with a RETRY event.
    clock.advance(waitMs + 1)
    const released = await releaseDueDeferred(store, 'extract', clock.now())
    expect(released).toBe(1)
    expect(await store.listByStates(['deferred'])).toHaveLength(0)
    const history = await store.getHistory(deferred!.id)
    expect(history.some((h) => h.event === 'DEFER')).toBe(true)
    expect(history.some((h) => h.event === 'RETRY')).toBe(true)
  })
})

describe('pipeline: max attempts move the link to errored', () => {
  it('after maxAttempts DEFER rounds the link ends up errored', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const [link] = await insertLinks(store, ['https://example.com/1'])
    // A hard block (403) defers every round; after maxAttempts rounds the
    // link moves to errored through the FSM.
    const extractFn: ExtractFn = async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    }

    const guard = guardDepsFromStore(store, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: { limits: UNLIMITED },
    })

    // The walled-garden breaker cooldown is hours; jump the fake clock past
    // each cooldown so the next round can claim the link again.
    for (let round = 0; round < 5; round += 1) {
      await extract(store, {
        extract: extractFn,
        guard,
        maxAttempts: 5,
        now: clock.now,
      })
      clock.advance(7 * 60 * 60 * 1000)
      await releaseDueDeferred(store, 'extract', clock.now())
    }
    const state = await store.getState(link.id)
    expect(state?.state).toBe('errored')
    expect(await attemptsOf(store, link.id)).toBeGreaterThanOrEqual(5)
  })
})

describe('pipeline: an llm 429 storm results in deferral not failure', () => {
  it('the llm breaker opens and the remaining links defer', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const links = await insertLinks(store, [
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])
    // Extract everything first so enrich has candidates.
    await extract(store, {
      extract: async (url) => ({ markdown: `content for ${url}`, extractor: 'defuddle' }),
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      now: clock.now,
    })
    clock.advance(60_000)

    let llmCalls = 0
    const enrichFn: EnrichFn = async () => {
      llmCalls += 1
      throw Object.assign(new Error('rate limited'), { status: 429 })
    }
    const result = await enrich(store, {
      enrich: enrichFn,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: UNLIMITED },
      }),
      maxAttempts: 99,
      now: clock.now,
    })

    // One probe fails, the breaker opens, the rest defer without calls.
    expect(llmCalls).toBe(1)
    expect(result.deferredCount).toBe(3)
    expect(result.errorCount).toBe(0)
    const llmState = await store.getHostState(LLM_KEY)
    expect(llmState?.breakerState).toBe('open')
    for (const link of links) {
      const state = await store.getState(link.id)
      expect(state?.state).toBe('deferred')
    }
  })
})

describe('pipeline: limiter state survives a store reload', () => {
  it('walled garden budget is enforced across two separate store opens', async () => {
    const clock = fakeClock()
    const store1 = await tempStore()
    const strictLimits = { ...DEFAULT_LIMITS, walledGardens: ['x.com'] }
    const guard1 = guardDepsFromStore(store1, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: { limits: strictLimits },
    })
    const guard2 = guardDepsFromStore(store1, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: { limits: strictLimits },
    })

    const gate = (g: ReturnType<typeof guardDepsFromStore>) =>
      (async () => {
        const outcome = await import('../src/resilience/index.js').then((m) =>
          m.guardRun(g, 'x.com', async () => 'ok'),
        )
        return outcome.kind
      })()

    // First "process": one request admitted, next spacing-deferred.
    expect(await gate(guard1)).toBe('ok')
    clock.advance(1000)
    expect(await gate(guard1)).toBe('defer')

    // Second "process", same persisted state: still spacing-deferred.
    clock.advance(1000)
    expect(await gate(guard2)).toBe('defer')

    // After the full interval the budget is available again.
    clock.advance(WALLED_GARDEN_LIMIT.intervalMs * 1.35)
    expect(await gate(guard2)).toBe('ok')
    await store1.close()
  })
})

describe('pipeline: walled garden daily cap under a burst', () => {
  it('a 500-link burst against a strict host makes at most the daily cap of requests', async () => {
    const store = await tempStore()
    const clock = fakeClock()
    const urls = Array.from({ length: 500 }, (_, i) => `https://x.com/p/${i}`)
    await insertLinks(store, urls)
    let fetches = 0
    const extractFn: ExtractFn = async (url) => {
      fetches += 1
      return { markdown: `content for ${url}`, extractor: 'browser' }
    }
    const guard = guardDepsFromStore(store, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: { limits: { ...DEFAULT_LIMITS, walledGardens: ['x.com'] } },
    })

    // Run in batches, advancing the clock past the spacing interval each time
    // (the batching the CLI does across invocations).
    for (let round = 0; round < 60; round += 1) {
      clock.advance(WALLED_GARDEN_LIMIT.intervalMs * 1.35)
      const result = await extract(store, {
        extract: extractFn,
        guard,
        maxAttempts: 2,
        maxBatch: 500,
        now: clock.now,
      })
      if (result.inputCount === 0) break
    }

    expect(fetches).toBeLessThanOrEqual(WALLED_GARDEN_LIMIT.dailyCap)
    const hostState = await store.getHostState('x.com')
    expect(hostState?.windowCount).toBeLessThanOrEqual(WALLED_GARDEN_LIMIT.dailyCap)
    await store.close()
  })
})
