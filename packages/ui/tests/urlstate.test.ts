import { describe, expect, it } from 'vitest'
import { parseUrlState, toUrlState, effectiveCollection } from '../src/lib/urlState'

describe('urlState', () => {
  it('parses the triage route contract', () => {
    const s = parseUrlState(
      new URLSearchParams('view=triage&collection=needs_login&selected=42&layout=bottom&q=foo&stale=1'),
    )
    expect(s.view).toBe('triage')
    expect(s.collection).toBe('needs_login')
    expect(s.selected).toBe(42)
    expect(s.layout).toBe('bottom')
    expect(s.q).toBe('foo')
    expect(s.stale).toBe(true)
  })

  it('defaults view to triage and layout to right; drops invalid values', () => {
    const s = parseUrlState(new URLSearchParams('collection=bogus&layout=nope&selected=abc&dialog=bogus'))
    expect(s.view).toBe('triage')
    expect(s.collection).toBe('')
    expect(s.layout).toBe('right')
    expect(s.dialog).toBe('')
    expect(s.selected).toBeNull()
    expect(effectiveCollection(s)).toBe('enriched')
  })

  it('parses layout=hidden and dialog=help', () => {
    const s = parseUrlState(new URLSearchParams('layout=hidden&dialog=help'))
    expect(s.layout).toBe('hidden')
    expect(s.dialog).toBe('help')
  })

  it('attention view defaults to needs_login collection', () => {
    const s = parseUrlState(new URLSearchParams('view=attention'))
    expect(effectiveCollection(s)).toBe('needs_login')
  })

  it('round-trips through toUrlState', () => {
    const s = parseUrlState(
      new URLSearchParams('view=attention&collection=blocked&host=x.com&q=test&dialog=ingest&layout=bottom'),
    )
    const p = toUrlState(s)
    const back = parseUrlState(p)
    expect(back).toEqual(s)
  })

  it('round-trips dialog=help', () => {
    const s = parseUrlState(new URLSearchParams('dialog=help'))
    expect(parseUrlState(toUrlState(s))).toEqual(s)
  })

  it('omits defaults when serializing', () => {
    const s = parseUrlState(new URLSearchParams(''))
    expect(toUrlState(s).toString()).toBe('')
  })
})
