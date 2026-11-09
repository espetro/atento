import { describe, expect, it } from 'vitest'
import { parseLayout, CATALOG_TYPES } from '../src/gen/catalog'
import { setLayout, resetLayout, viewLayout } from '../src/gen/layout'
import { get } from 'svelte/store'

describe('parseLayout', () => {
	it('accepts a valid tree', () => {
		const nodes = parseLayout([
			{ type: 'section', props: { title: 'x' }, children: [{ type: 'markdown', props: { text: 'hi' } }] },
			{ type: 'previewPanel' },
		])
		expect(nodes).toHaveLength(2)
	})

	it('returns null for non-arrays / malformed shapes', () => {
		expect(parseLayout('nope')).toBeNull()
		expect(parseLayout([{ type: 5 }])).toBeNull()
	})

	it('drops nodes whose props fail their schema', () => {
		const nodes = parseLayout([
			{ type: 'button', props: { label: 'ok', action: 'open' } },
			{ type: 'button', props: { nope: true } },
		])
		expect(nodes).toHaveLength(1)
		expect(nodes![0]!.props?.action).toBe('open')
	})

	it('drops unknown types that carry props', () => {
		const nodes = parseLayout([{ type: 'evil', props: { onload: 'x()' } }])
		expect(nodes).toHaveLength(0)
	})

	it('catalog includes the documented node types', () => {
		for (const t of ['section', 'twoColumn', 'markdown', 'button', 'metric', 'chips', 'toolbar', 'previewPanel', 'metadataPanel', 'rowList']) {
			expect(CATALOG_TYPES).toContain(t)
		}
	})
})

describe('layout storage', () => {
	it('round-trips an override and falls back after reset', () => {
		const def = [{ type: 'previewPanel' }]
		expect(setLayout('testview', def)).toBe(true)
		const layout = viewLayout('testview', def)
		expect(get(layout)).toEqual(def)
		expect(setLayout('testview', [{ type: 5 }])).toBe(false)
		resetLayout('testview')
		expect(get(layout)).toEqual(def)
	})
})
