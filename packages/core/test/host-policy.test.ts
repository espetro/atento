/**
 * Host policy tests: the local-host rule and the pattern matching it uses.
 * Everything is pure and offline: no fetch, no browser, no clock.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  hostPolicy,
  isLoopbackHost,
  matchesPattern,
} from '../src/resilience/limiter.js'
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
