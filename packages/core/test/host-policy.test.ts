/**
 * Host policy tests: the local-host rule and the pattern matching it uses.
 * Everything is pure and offline: no fetch, no browser, no clock.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  hostPolicy,
  isLoopbackHost,
  loginAllowed,
  matchesPattern,
} from '../src/resilience/limiter.js'
import { parseLoginConfig } from '../src/config.js'
import { hostOf } from '../src/pipeline/resilience.js'

describe('hostOf: the hostname without the port', () => {
  it('drops the port', () => {
    expect(hostOf('http://localhost:3000/x')).toBe('localhost')
    expect(hostOf('https://example.com:8443/a/b?c=1')).toBe('example.com')
  })

  it('lowercases the host and keeps the ipv6 brackets off', () => {
    expect(hostOf('http://LocalHost:3000/')).toBe('localhost')
    expect(hostOf('http://[::1]:8080/x')).toBe('::1')
  })

  it('returns unknown for an unparsable url', () => {
    expect(hostOf('not a url')).toBe('unknown')
  })
})

describe('loopback hosts are skipped by default', () => {
  it('recognises the loopback names', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('app.localhost')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })

  it('skips them even without a config entry', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', 'app.localhost']) {
      const policy = hostPolicy(DEFAULT_LIMITS, host)
      expect(policy.skipped).toBe(true)
      expect(policy.strict).toBe(false)
      expect(policy.browser).toBe(false)
    }
  })

  it('skips a loopback link captured with a port', () => {
    const host = hostOf('http://localhost:4173/capture')
    expect(host).toBe('localhost')
    expect(hostPolicy(DEFAULT_LIMITS, host).skipped).toBe(true)
  })

  it('does not hardcode a skip-list entry: the config list stays empty', () => {
    expect(DEFAULT_LIMITS.skipHosts).toEqual([])
  })
})

describe('pattern matching ignores the port', () => {
  it('matches an exact host', () => {
    expect(matchesPattern(['localhost'], 'localhost')).toBe(true)
    expect(matchesPattern(['localhost'], 'example.com')).toBe(false)
  })

  it('matches a *.suffix wildcard against the host and its subdomains', () => {
    expect(matchesPattern(['*.localhost'], 'localhost')).toBe(true)
    expect(matchesPattern(['*.localhost'], 'app.localhost')).toBe(true)
    expect(matchesPattern(['*.localhost'], 'notlocalhost')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesPattern(['LOCALHOST'], 'localhost')).toBe(true)
    expect(matchesPattern(['*.LocalHost'], 'app.localhost')).toBe(true)
  })
})

describe('review hosts: never fetched, links stay visible', () => {
  it('marks a listed host review-only', () => {
    const cfg = { ...DEFAULT_LIMITS, reviewHosts: ['revolut.com', '*.revolut.com'] }
    expect(hostPolicy(cfg, 'revolut.com')).toMatchObject({
      reviewOnly: true,
      skipped: false,
      strict: false,
      browser: false,
      reason: 'review_only',
    })
    expect(hostPolicy(cfg, 'app.revolut.com').reviewOnly).toBe(true)
    expect(hostPolicy(cfg, 'revolut.com.evil.example').reviewOnly).toBe(false)
  })

  it('wins over the login gate: a gated review host is review-only', () => {
    const cfg = { ...DEFAULT_LIMITS, reviewHosts: ['revolut.com'] }
    const policy = hostPolicy(cfg, 'revolut.com', { loginGated: true, hasProfile: false })
    expect(policy).toMatchObject({ reviewOnly: true, skipped: false, reason: 'review_only' })
  })

  it('wins over a saved profile too', () => {
    const cfg = { ...DEFAULT_LIMITS, reviewHosts: ['revolut.com'] }
    const policy = hostPolicy(cfg, 'revolut.com', { hasProfile: true })
    expect(policy.reviewOnly).toBe(true)
  })

  it('loses to the skip list', () => {
    const cfg = { ...DEFAULT_LIMITS, skipHosts: ['revolut.com'], reviewHosts: ['revolut.com'] }
    const policy = hostPolicy(cfg, 'revolut.com')
    expect(policy).toMatchObject({ skipped: true, reviewOnly: false, reason: 'skip_list' })
  })

  it('leaves unlisted hosts alone', () => {
    const cfg = { ...DEFAULT_LIMITS, reviewHosts: ['revolut.com'] }
    expect(hostPolicy(cfg, 'example.com')).toMatchObject({
      reviewOnly: false,
      skipped: false,
      strict: false,
      reason: null,
    })
  })
})

describe('the [login] allow list', () => {
  it('parses the [login] table', () => {
    const login = parseLoginConfig(`
[login]
allow = ["app.devin.ai", "chat.z.ai", "*.usebrioso.com", "docs.google.com", "figma.com"]
`)
    expect(login.allow).toEqual([
      'app.devin.ai',
      'chat.z.ai',
      '*.usebrioso.com',
      'docs.google.com',
      'figma.com',
    ])
  })

  it('defaults to no restriction when the table is missing', () => {
    expect(parseLoginConfig('').allow).toEqual([])
  })

  it('keeps every login-walled host allowed while the list is empty', () => {
    expect(loginAllowed([], 'x.com')).toBe(true)
    expect(loginAllowed(undefined, 'x.com')).toBe(true)
    // The default policy decision is unchanged too.
    const policy = hostPolicy(DEFAULT_LIMITS, 'x.com', { loginGated: true })
    expect(policy).toMatchObject({ strict: true, browser: true, reviewOnly: false })
  })

  it('a login-walled host outside the allow list is review-only', () => {
    const allow = ['app.devin.ai', 'docs.google.com']
    const policy = hostPolicy(DEFAULT_LIMITS, 'revolut.com', { loginGated: true, loginAllow: allow })
    expect(policy).toMatchObject({
      reviewOnly: true,
      skipped: false,
      strict: false,
      browser: false,
      reason: 'review_only',
    })
  })

  it('a host in the allow list keeps the login-gated policy', () => {
    const allow = ['app.devin.ai', '*.google.com']
    expect(
      hostPolicy(DEFAULT_LIMITS, 'app.devin.ai', { loginGated: true, loginAllow: allow }),
    ).toMatchObject({ strict: true, browser: true, reviewOnly: false, reason: 'login_gated' })
    expect(
      hostPolicy(DEFAULT_LIMITS, 'docs.google.com', { loginGated: true, loginAllow: allow }),
    ).toMatchObject({ strict: true, browser: true, reviewOnly: false })
  })

  it('a saved profile overrides the allow list: the session exists already', () => {
    const allow = ['app.devin.ai']
    expect(
      hostPolicy(DEFAULT_LIMITS, 'x.com', { loginGated: true, loginAllow: allow, hasProfile: true }),
    ).toMatchObject({ strict: true, browser: true, reviewOnly: false, reason: 'login_gated' })
    expect(loginAllowed(allow, 'x.com', true)).toBe(true)
  })

  it('does not touch ordinary open hosts', () => {
    const allow = ['app.devin.ai']
    expect(hostPolicy(DEFAULT_LIMITS, 'example.com', { loginAllow: allow })).toMatchObject({
      reviewOnly: false,
      strict: false,
      reason: null,
    })
  })
})
