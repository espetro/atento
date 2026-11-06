/**
 * Park reason tests: the classification of an extraction outcome into a
 * reason class, the parsing of a stored reason, and the parked-link
 * histogram. Pure functions and a fake store: nothing sleeps and nothing
 * touches the network.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyParkOutcome,
  emptyParkReasonCounts,
  isKnownParkReason,
  looksLikeBotBlock,
  looksLikeTimeoutError,
  looksLikeTimeoutStatus,
  PARK_REASONS,
  parseParkReason,
  parkReasonOfStateData,
  parkedReasonOf,
  type ParkReason,
} from '../src/index.js'
import { FakeStore, seedLink } from './fake-store.js'

describe('the park reason classes', () => {
  it('lists every class in a stable order', () => {
    expect(PARK_REASONS).toEqual([
      'login_wall',
      'bot_block',
      'js_shell',
      'http_error',
      'timeout',
      'review_only',
      'unknown',
    ])
  })

  it('knows which values are real classes', () => {
    expect(isKnownParkReason('login_wall')).toBe(true)
    expect(isKnownParkReason('bot_block')).toBe(true)
    expect(isKnownParkReason('unknown')).toBe(false)
    expect(isKnownParkReason('skip_host')).toBe(false)
    expect(isKnownParkReason(undefined)).toBe(false)
  })

  it('starts every histogram class at zero', () => {
    const counts = emptyParkReasonCounts()
    expect(Object.keys(counts).sort()).toEqual([...PARK_REASONS].sort())
    expect(counts.login_wall).toBe(0)
    expect(counts.unknown).toBe(0)
  })
})

describe('classifyParkOutcome', () => {
  it('classifies a login wall', () => {
    expect(classifyParkOutcome({ isLoginWall: true })).toBe('login_wall')
    expect(classifyParkOutcome({ blocked: true, blockReason: 'login_wall' })).toBe('login_wall')
    expect(classifyParkOutcome({ blocked: true })).toBe('login_wall')
    expect(classifyParkOutcome({ blocked: true, blockReason: 'private_404' })).toBe('login_wall')
  })

  it('classifies a bot block: captcha and challenge markers', () => {
    expect(classifyParkOutcome({ markdown: 'Please complete the captcha' })).toBe('bot_block')
    expect(
      classifyParkOutcome({ html: '<title>Just a moment...</title><div id="cf-browser-verification">' }),
    ).toBe('bot_block')
    expect(classifyParkOutcome({ html: 'Checking your browser before accessing example.com' })).toBe(
      'bot_block',
    )
    expect(classifyParkOutcome({ markdown: 'Verify you are human to continue' })).toBe('bot_block')
    // A block the extractor reports with a non-login reason is a bot block.
    expect(classifyParkOutcome({ blocked: true, blockReason: 'bot_block' })).toBe('bot_block')
    expect(classifyParkOutcome({ blocked: true, blockReason: 'captcha' })).toBe('bot_block')
  })

  it('classifies a bot block: the refusal statuses', () => {
    expect(classifyParkOutcome({ status: 403 })).toBe('bot_block')
    expect(classifyParkOutcome({ status: 429 })).toBe('bot_block')
    expect(classifyParkOutcome({ status: 999 })).toBe('bot_block')
  })

  it('classifies a JS shell: empty or script-only content', () => {
    expect(classifyParkOutcome({})).toBe('js_shell')
    expect(classifyParkOutcome({ markdown: '   ' })).toBe('js_shell')
    expect(
      classifyParkOutcome({
        html: '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
      }),
    ).toBe('js_shell')
  })

  it('classifies an http error: any other 4xx or 5xx', () => {
    expect(classifyParkOutcome({ status: 500 })).toBe('http_error')
    expect(classifyParkOutcome({ status: 502 })).toBe('http_error')
    expect(classifyParkOutcome({ status: 400 })).toBe('http_error')
    expect(classifyParkOutcome({ status: 404 })).toBe('http_error')
    expect(classifyParkOutcome({ gone: 410 })).toBe('http_error')
  })

  it('classifies a timeout: the statuses and the error wording', () => {
    expect(classifyParkOutcome({ status: 408 })).toBe('timeout')
    expect(classifyParkOutcome({ status: 504 })).toBe('timeout')
    expect(classifyParkOutcome({ error: 'request timed out' })).toBe('timeout')
    expect(classifyParkOutcome({ error: 'ETIMEDOUT' })).toBe('timeout')
  })

  it('leaves real content unclassified', () => {
    expect(classifyParkOutcome({ markdown: '# A real article', status: 200 })).toBe('unknown')
  })

  it('prefers the login wall over the status', () => {
    // A 403 behind a login form is a login wall, not a bot block.
    expect(classifyParkOutcome({ isLoginWall: true, status: 403 })).toBe('login_wall')
  })
})

describe('the marker helpers', () => {
  it('spots the bot-block markers', () => {
    expect(looksLikeBotBlock('Solve the captcha to continue')).toBe(true)
    expect(looksLikeBotBlock('Just a moment...')).toBe(true)
    expect(looksLikeBotBlock('A normal article about databases')).toBe(false)
    expect(looksLikeBotBlock(undefined)).toBe(false)
  })

  it('spots the timeout statuses and the timeout wording', () => {
    expect(looksLikeTimeoutStatus(408)).toBe(true)
    expect(looksLikeTimeoutStatus(504)).toBe(true)
    expect(looksLikeTimeoutStatus(500)).toBe(false)
    expect(looksLikeTimeoutStatus(undefined)).toBe(false)
    expect(looksLikeTimeoutError('deadline exceeded')).toBe(true)
    expect(looksLikeTimeoutError('boom')).toBe(false)
  })
})

describe('parseParkReason', () => {
  it('parses the classes themselves', () => {
    expect(parseParkReason('login_wall')).toBe('login_wall')
    expect(parseParkReason('bot_block')).toBe('bot_block')
    expect(parseParkReason('js_shell')).toBe('js_shell')
    expect(parseParkReason('http_error')).toBe('http_error')
    expect(parseParkReason('timeout')).toBe('timeout')
    expect(parseParkReason('review_only')).toBe('review_only')
  })

  it('parses the guard composites', () => {
    expect(parseParkReason('blocked:login_wall')).toBe('login_wall')
    expect(parseParkReason('blocked:http_429')).toBe('bot_block')
    expect(parseParkReason('blocked:http_403')).toBe('bot_block')
    expect(parseParkReason('canary_flagged:login_wall')).toBe('login_wall')
    expect(parseParkReason('blocked:http_500')).toBe('http_error')
    expect(parseParkReason('blocked:http_504')).toBe('timeout')
  })

  it('parses the private-page reasons as login walls', () => {
    expect(parseParkReason('private_404')).toBe('login_wall')
    expect(parseParkReason('private_410')).toBe('login_wall')
  })

  it('strips the failure suffix the pipeline appends', () => {
    expect(parseParkReason('blocked:login_wall (max attempts exhausted)')).toBe('login_wall')
  })

  it('parses an empty or unknown reason as unknown', () => {
    expect(parseParkReason('')).toBe('unknown')
    expect(parseParkReason('   ')).toBe('unknown')
    expect(parseParkReason(undefined)).toBe('unknown')
    expect(parseParkReason(null)).toBe('unknown')
    expect(parseParkReason(42)).toBe('unknown')
    expect(parseParkReason('skip_host')).toBe('unknown')
  })
})

describe('parkedReasonOf', () => {
  it('reads the class of a parked needs_browser row', () => {
    expect(parkedReasonOf('needs_browser', { host: 'x.example', reason: 'login_wall' })).toBe(
      'login_wall',
    )
  })

  it('reads a legacy row with no reason as unknown', () => {
    expect(parkedReasonOf('needs_browser', { host: 'x.example' })).toBe('unknown')
    expect(parkedReasonOf('needs_browser', null)).toBe('unknown')
  })

  it('counts a blocked deferral as parked and a throttle as not parked', () => {
    expect(
      parkedReasonOf('deferred', { reason: 'blocked:http_429', attempts: 1, stage: 'extract' }),
    ).toBe('bot_block')
    expect(
      parkedReasonOf('deferred', { reason: 'spacing', attempts: 0, stage: 'extract' }),
    ).toBeNull()
    expect(
      parkedReasonOf('deferred', { reason: 'daily_cap', attempts: 0, stage: 'extract' }),
    ).toBeNull()
  })

  it('is not parked in any other state', () => {
    expect(parkedReasonOf('created', null)).toBeNull()
    expect(parkedReasonOf('errored', { error: 'timeout' })).toBeNull()
    expect(parkedReasonOf('inbox', null)).toBeNull()
  })

  it('reads the class of a state payload', () => {
    expect(parkReasonOfStateData({ reason: 'bot_block' })).toBe('bot_block')
    expect(parkReasonOfStateData({ error: 'http_500' })).toBe('http_error')
    expect(parkReasonOfStateData(null)).toBe('unknown')
  })
})

describe('the stored reason class', () => {
  it('parses a legacy parked row as unknown', async () => {
    const store = new FakeStore()
    await seedLink(store, 'https://legacy.example/a', {
      state: 'needs_browser',
      stateData: { host: 'legacy.example' },
    })
    const parked = await store.listByStates(['needs_browser'])
    expect(parked).toHaveLength(1)
    expect(parkReasonOfStateData(parked[0]?.stateData ?? null)).toBe('unknown')
  })

  it('carries the class on a parked row', async () => {
    const store = new FakeStore()
    await seedLink(store, 'https://gated.example/a', {
      state: 'needs_browser',
      stateData: { host: 'gated.example', reason: 'login_wall', reasonClass: 'login_wall' },
    })
    const parked = await store.listByStates(['needs_browser'])
    const row = parked[0]
    expect(row?.stateData?.['reasonClass']).toBe('login_wall')
    expect(parkedReasonOf(row?.state ?? 'created', row?.stateData ?? null)).toBe('login_wall')
  })

  it('accepts every class as a stored reason class', () => {
    const classes: ParkReason[] = [
      'login_wall',
      'bot_block',
      'js_shell',
      'http_error',
      'timeout',
      'review_only',
      'unknown',
    ]
    for (const cls of classes) {
      expect(parkReasonOfStateData({ reason: cls })).toBe(cls)
    }
  })
})
