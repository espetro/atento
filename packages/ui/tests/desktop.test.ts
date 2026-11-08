import { describe, expect, it } from 'vitest'
import { hostKeyForUrl, isDesktopShell, partitionForHost } from '../src/lib/desktop'

describe('desktop shell detection', () => {
  it('is false in jsdom / plain web', () => {
    expect(isDesktopShell()).toBe(false)
  })
})

describe('hostKeyForUrl', () => {
  it('extracts the lowercase hostname', () => {
    expect(hostKeyForUrl('https://GitHub.com/foo/bar')).toBe('github.com')
    expect(hostKeyForUrl('https://sub.example.com:8443/x?y=1')).toBe('sub.example.com')
  })

  it('falls back to the raw string for unparseable URLs', () => {
    expect(hostKeyForUrl('not a url')).toBe('not a url')
  })
})

describe('partitionForHost', () => {
  it('produces a persist: partition keyed by host', () => {
    expect(partitionForHost('github.com')).toBe('persist:linkinbox-github.com')
  })

  it('sanitizes unsafe characters', () => {
    expect(partitionForHost('exa mple.com')).toBe('persist:linkinbox-exa_mple.com')
  })
})
