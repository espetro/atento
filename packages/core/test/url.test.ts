import { describe, expect, it } from 'vitest'
import { normalizeUrl } from '../src/url.js'

describe('normalizeUrl', () => {
  it('strips utm_ params, fbclid, ref and trailing slashes', () => {
    const cases: Array<[string, string]> = [
      [
        'https://example.com/page?utm_source=news&utm_medium=email&id=7',
        'https://example.com/page?id=7',
      ],
      ['https://example.com/page?fbclid=abc', 'https://example.com/page'],
      ['https://example.com/page?ref=partner', 'https://example.com/page'],
      ['https://example.com/page/', 'https://example.com/page'],
      ['https://example.com/', 'https://example.com/'],
      [
        'https://example.com/a/b/?utm_campaign=x&fbclid=y',
        'https://example.com/a/b',
      ],
    ]
    for (const [input, expected] of cases) {
      expect(normalizeUrl(input).url).toBe(expected)
    }
  })

  it('keeps meaningful params and their order', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1').url).toBe(
      'https://example.com/p?b=2&a=1',
    )
  })

  it('lowercases host and drops default ports', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/x').url).toBe('https://example.com/x')
    expect(normalizeUrl('http://Example.com:80/x').url).toBe('http://example.com/x')
  })

  it('hashes equal normalized urls identically and different urls differently', () => {
    const a = normalizeUrl('https://example.com/p?utm_source=x')
    const b = normalizeUrl('https://example.com/p')
    const c = normalizeUrl('https://example.com/q')
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not throw on unparseable input', () => {
    const r = normalizeUrl('not a url')
    expect(r.url).toBe('not a url')
    expect(r.hash).toHaveLength(64)
  })
})
