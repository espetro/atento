/**
 * The shared browser read path: the allowlist gate, the profile gate, the
 * guard (pacing, daily cap, working hours, breaker) and the read-only
 * promise. Nothing sleeps, nothing hits the network: the read primitive is
 * a fake and the clock is injected.
 */
import { describe, expect, it } from 'vitest'
import { FakeStore } from './fake-store.js'
import {
  browseRead,
  guardDepsFromStore,
  listShareHosts,
  parseShareConfig,
  DEFAULT_LIMITS,
  type BrowseFn,
} from '../src/index.js'

const SHARED = { hosts: ['shared.example', '*.wild.example'] }

function fakeClock(start = 1_000_000) {
  let now = start
  return {
    ms: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** A read primitive that records what it was asked to read. */
function fakeRead(
  result: Partial<Awaited<ReturnType<BrowseFn>>> = {},
): { read: BrowseFn; calls: { url: string; host: string }[] } {
  const calls: { url: string; host: string }[] = []
  const read: BrowseFn = async (url, host) => {
    calls.push({ url, host })
    return {
      ok: true,
      markdown: `# page\n\ncontent of ${url}`,
      engine: 'fake',
      ...result,
    }
  }
  return { read, calls }
}

describe('browse: the allowlist', () => {
  it('refuses a host that is not shared and never calls the browser', async () => {
    const { read, calls } = fakeRead()
    const result = await browseRead('https://private.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_shared')
    expect(calls).toHaveLength(0)
  })

  it('refuses every host when the allowlist is empty (the default)', async () => {
    const { read, calls } = fakeRead()
    const result = await browseRead('https://shared.example/page', {
      share: { hosts: [] },
      read,
      hasProfile: async () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_shared')
    expect(calls).toHaveLength(0)
  })

  it('reads a shared host', async () => {
    const { read, calls } = fakeRead()
    const result = await browseRead('https://shared.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
    })
    expect(result.ok).toBe(true)
    expect(result.markdown).toContain('content of https://shared.example/page')
    expect(result.host).toBe('shared.example')
    expect(calls).toEqual([{ url: 'https://shared.example/page', host: 'shared.example' }])
  })

  it('matches a wildcard host', async () => {
    const { read } = fakeRead()
    const result = await browseRead('https://team.wild.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
    })
    expect(result.ok).toBe(true)
  })

  it('refuses an invalid url', async () => {
    const { read, calls } = fakeRead()
    const result = await browseRead('not a url', {
      share: SHARED,
      read,
      hasProfile: async () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_url')
    expect(calls).toHaveLength(0)
  })
})

describe('browse: the profile gate', () => {
  it('refuses a shared host without a saved profile', async () => {
    const { read, calls } = fakeRead()
    const result = await browseRead('https://shared.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_profile')
    expect(result.detail).toContain('atento login')
    expect(calls).toHaveLength(0)
  })
})

describe('browse: the guard', () => {
  it('defers a read outside the working hours', async () => {
    const store = await new FakeStore()
    // A saved profile makes the host strict, so the human pacing profile
    // (with its working-hours window) applies, exactly like the pipeline.
    await store.upsertProfile({ host: 'shared.example', path: '/tmp/profile' })
    const { read, calls } = fakeRead()
    // 03:00 local: outside the default 08:00 to 23:00 window.
    const threeAm = new Date(2026, 0, 15, 3, 0, 0).getTime()
    const result = await browseRead('https://shared.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
      guard: guardDepsFromStore(store, {
        clock: () => threeAm,
        random: () => 0,
        sleep: async () => {},
        config: { limits: DEFAULT_LIMITS },
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('deferred')
    expect(result.detail).toBe('outside_hours')
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
  })

  it('defers a read that would exceed the daily cap', async () => {
    const store = await new FakeStore()
    const clock = fakeClock()
    const { read, calls } = fakeRead()
    const guard = guardDepsFromStore(store, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: {
        limits: {
          ...DEFAULT_LIMITS,
          hosts: { 'shared.example': { intervalMs: 0, dailyCap: 2, concurrency: 10 } },
        },
        pacing: {
          dwellMedianS: 1,
          dwellMaxS: 1,
          breakEveryMin: 100,
          breakEveryMax: 100,
          breakMinS: 0,
          breakMaxS: 0,
          dailyCap: 100,
          hoursStart: 0,
          hoursEnd: 24,
        },
      },
    })
    // The first two reads spend the cap; the third is deferred.
    for (let i = 0; i < 2; i += 1) {
      const ok = await browseRead('https://shared.example/page', {
        share: SHARED,
        read,
        hasProfile: async () => true,
        guard,
      })
      expect(ok.ok).toBe(true)
      clock.advance(10_000)
    }
    const third = await browseRead('https://shared.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
      guard,
    })
    expect(third.ok).toBe(false)
    expect(third.reason).toBe('deferred')
    expect(calls).toHaveLength(2)
  })

  it('reports a login wall as a block and does not retry', async () => {
    const store = await new FakeStore()
    const clock = fakeClock()
    await store.upsertProfile({ host: 'shared.example', path: '/tmp/profile' })
    let calls = 0
    const read: BrowseFn = async () => {
      calls += 1
      return { ok: false, markdown: '', reason: 'login_wall', detail: 'login wall' }
    }
    const result = await browseRead('https://shared.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: DEFAULT_LIMITS },
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('login_wall')
    expect(calls).toBe(1)
  })
})

describe('browse: nothing is written to the link store', () => {
  it('leaves the links and the store untouched', async () => {
    const store = await new FakeStore()
    const clock = fakeClock()
    const { read } = fakeRead()
    await browseRead('https://shared.example/page', {
      share: SHARED,
      read,
      hasProfile: async () => true,
      guard: guardDepsFromStore(store, {
        clock: () => clock.ms(),
        random: () => 0,
        sleep: async () => {},
        config: { limits: DEFAULT_LIMITS },
      }),
    })
    const links = await store.listLinks({ limit: 100 })
    expect(links).toHaveLength(0)
  })
})

describe('browse: the share host list', () => {
  it('marks each saved profile with its share verdict', async () => {
    const rows = await listShareHosts(
      [{ host: 'shared.example' }, { host: 'private.example' }],
      SHARED,
    )
    expect(rows).toEqual([
      {
        host: 'private.example',
        shared: false,
        hasProfile: true,
        ready: false,
        reason: 'not_shared',
      },
      {
        host: 'shared.example',
        shared: true,
        hasProfile: true,
        ready: true,
        reason: undefined,
      },
    ])
  })
})

describe('share config', () => {
  it('ships with an empty allowlist', () => {
    expect(parseShareConfig('').hosts).toEqual([])
  })

  it('reads the hosts and lowercases them', () => {
    expect(parseShareConfig('[share]\nhosts = ["X.com", "*.Example.com"]').hosts).toEqual([
      'x.com',
      '*.example.com',
    ])
  })
})
