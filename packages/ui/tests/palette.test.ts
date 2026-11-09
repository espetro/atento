import { describe, expect, it } from 'vitest'
import { paletteCommands, scoreCommand, type PaletteDeps } from '../src/lib/palette'
import { parseUrlState } from '../src/lib/urlState'

const deps: PaletteDeps = {
	setUrl: () => {},
	invalidate: () => {},
}

function url(over: Record<string, string> = {}) {
	return parseUrlState(new URLSearchParams(over))
}

describe('scoreCommand', () => {
	it('ranks prefix > infix > subsequence > no match', () => {
		expect(scoreCommand('archive', '', 'ar')).toBe(100)
		expect(scoreCommand('clear all filters', '', 'filt')).toBeGreaterThan(0)
		expect(scoreCommand('archive', '', 'ac')).toBe(20) // subsequence
		expect(scoreCommand('archive', '', 'zz')).toBe(-1)
	})
	it('matches keywords too', () => {
		expect(scoreCommand('go to run', 'nav pipeline', 'pipe')).toBeGreaterThan(0)
	})
})

describe('paletteCommands', () => {
	it('returns nav/app commands with empty query', () => {
		const cmds = paletteCommands(url(), '', deps)
		expect(cmds.some((c) => c.id === 'view.triage')).toBe(true)
		expect(cmds.some((c) => c.id === 'app.ingest')).toBe(true)
	})

	it('filters by query and boosts search first', () => {
		const cmds = paletteCommands(url(), 'arch', deps)
		expect(cmds.length).toBeGreaterThan(0)
		expect(cmds[0]!.id).toBe('search')
		expect(cmds.every((c) => c.id === 'search' || /arc/i.test(c.label + (c.keywords ?? '')))).toBe(true)
	})

	it('hides link actions with no selection, shows them when selected', () => {
		const none = paletteCommands(url(), '', deps)
		expect(none.some((c) => c.id === 'link.archive')).toBe(false)
		const sel = paletteCommands(url({ selected: '12' }), '', deps)
		for (const a of ['link.open', 'link.archive', 'link.schedule', 'link.discard', 'link.reextract', 'link.copy-url']) {
			expect(sel.some((c) => c.id === a)).toBe(true)
		}
	})

	it('offers clear-filters only when a filter is active', () => {
		expect(paletteCommands(url(), '', deps).some((c) => c.id === 'filters.clear')).toBe(false)
		expect(
			paletteCommands(url({ state: 'errored' }), '', deps).some((c) => c.id === 'filters.clear'),
		).toBe(true)
	})

	it('omits the current layout mode', () => {
		const cmds = paletteCommands(url(), '', deps)
		expect(cmds.some((c) => c.id === 'layout.right')).toBe(false)
		expect(cmds.some((c) => c.id === 'layout.bottom')).toBe(true)
	})
})
