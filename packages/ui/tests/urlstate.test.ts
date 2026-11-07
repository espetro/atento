import { describe, expect, it } from 'vitest'
import { parseUrlState, toUrlState, effectiveCollection } from '../src/lib/urlState'

describe('urlState', () => {
  it('parses the triage route contract', () => {
    const s = parseUrlState(
      new URLSearchParams('view=triage&collection=needs_login&selected=42&tab=metadata&q=foo&stale=1'),
    )
    expect(s.view).toBe('triage')
    expect(s.collection).toBe('needs_login')
    expect(s.selected).toBe(42)
    expect(s.tab).toBe('metadata')
    expect(s.q).toBe('foo')
    expect(s.stale).toBe(true)
  })

  it('defaults view to triage and tab to reader; drops invalid values', () => {
    const s = parseUrlState(new URLSearchParams('collection=bogus&tab=nope&selected=abc'))
    expect(s.view).toBe('triage')
    expect(s.collection).toBe('')
    expect(s.tab).toBe('reader')
    expect(s.selected).toBeNull()
    expect(effectiveCollection(s)).toBe('enriched')
  })

  it('attention view defaults to needs_login collection', () => {
    const s = parseUrlState(new URLSearchParams('view=attention'))
    expect(effectiveCollection(s)).toBe('needs_login')
  })

  it('round-trips through toUrlState', () => {
    const s = parseUrlState(
      new URLSearchParams('view=attention&collection=blocked&host=x.com&q=test&dialog=ingest'),
    )
    const p = toUrlState(s)
    const back = parseUrlState(p)
    expect(back).toEqual(s)
  })

  it('omits defaults when serializing', () => {
    const s = parseUrlState(new URLSearchParams(''))
    expect(toUrlState(s).toString()).toBe('')
  })
})
