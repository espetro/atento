import type { Component } from 'svelte'
import { get } from 'svelte/store'
import { api } from './api'
import { dispatchMenuAction } from './desktop'
import { density, setDensity } from './prefs'
import type { UrlState, ViewName } from './urlState'
import { m } from '../paraglide/messages.js'

import IconSearch from '~icons/lucide/search'
import IconInbox from '~icons/lucide/inbox'
import IconTriangleAlert from '~icons/lucide/triangle-alert'
import IconActivity from '~icons/lucide/activity'
import IconChartColumn from '~icons/lucide/chart-column'
import IconSettings from '~icons/lucide/settings'
import IconExternalLink from '~icons/lucide/external-link'
import IconArchive from '~icons/lucide/archive'
import IconCalendarClock from '~icons/lucide/calendar-clock'
import IconTrash2 from '~icons/lucide/trash-2'
import IconRefreshCw from '~icons/lucide/refresh-cw'
import IconCopy from '~icons/lucide/copy'
import IconFilterX from '~icons/lucide/filter-x'
import IconTimer from '~icons/lucide/timer'
import IconPanelRight from '~icons/lucide/panel-right'
import IconPanelBottom from '~icons/lucide/panel-bottom'
import IconEyeOff from '~icons/lucide/eye-off'
import IconRows3 from '~icons/lucide/rows-3'
import IconPlus from '~icons/lucide/plus'
import IconPlay from '~icons/lucide/play'
import IconKeyboard from '~icons/lucide/keyboard'
import IconSparkles from '~icons/lucide/sparkles'

/**
 * Command palette model (P1.1). `paletteCommands` is pure-ish (reads the
 * density store, dispatches through the same `linkinbox:menu-action` event
 * the shell context menus use) so vitest can exercise it without a DOM.
 */

export interface PaletteCommand {
	id: string
	label: string
	keywords?: string
	hint?: string
	icon?: Component
	/** Sort boost on top of the fuzzy score (search-first). */
	boost?: number
	run: () => void
}

export interface PaletteDeps {
	setUrl: (next: Partial<UrlState>) => void
	/** Invalidate TanStack queries (refresh data). */
	invalidate: () => void
	/** Present when the ACP assistant drawer is available (desktop shell). */
	openAssistant?: () => void
}

/**
 * Substring-then-subsequence match. Returns -1 for no match; higher is
 * better (prefix > infix > scattered subsequence).
 */
export function scoreCommand(label: string, keywords: string, query: string): number {
	const q = query.trim().toLowerCase()
	if (q === '') return 0
	const hay = `${label} ${keywords}`.toLowerCase()
	const idx = hay.indexOf(q)
	if (idx === 0) return 100
	if (idx > 0) return 60 - Math.min(idx, 40)
	let qi = 0
	for (let i = 0; i < hay.length && qi < q.length; i++) {
		if (hay[i] === q[qi]) qi++
	}
	return qi === q.length ? 20 : -1
}

/** Dispatch a triage/open/copy action for `id` through the menu-action bus. */
function linkDispatch(action: string, id: number, needsUrl: boolean): () => void {
	if (!needsUrl) {
		return () => dispatchMenuAction({ action, data: { id } })
	}
	return () => {
		void api
			.link(id)
			.then((l) => dispatchMenuAction({ action, data: { id, url: l.url } }))
			.catch(() => {})
	}
}

/** All commands available for `url`, filtered+sorted against `query`. */
export function paletteCommands(
	url: UrlState,
	query: string,
	deps: PaletteDeps,
): PaletteCommand[] {
	const q = query.trim()
	const cmds: PaletteCommand[] = []

	if (q !== '') {
		cmds.push({
			id: 'search',
			label: m.palette_search_links({ q }),
			icon: IconSearch,
			boost: 150,
			run: () => deps.setUrl({ view: 'triage', q }),
		})
	}

	// Selected-link actions route through `linkinbox:menu-action` — the same
	// bus the native shell context menus use, so triage/attention handlers
	// serve both.
	const id = url.selected
	if (id != null) {
		cmds.push(
			{
				id: 'link.open',
				label: m.action_open(),
				hint: 'o',
				icon: IconExternalLink,
				run: linkDispatch('link.open', id, true),
			},
			{
				id: 'link.archive',
				label: m.action_archive(),
				hint: 'a',
				icon: IconArchive,
				run: linkDispatch('link.archive', id, false),
			},
			{
				id: 'link.schedule',
				label: m.action_schedule(),
				hint: 's',
				icon: IconCalendarClock,
				run: linkDispatch('link.schedule', id, false),
			},
			{
				id: 'link.discard',
				label: m.action_discard(),
				hint: 'd',
				icon: IconTrash2,
				run: linkDispatch('link.discard', id, false),
			},
			{
				id: 'link.reextract',
				label: m.action_reextract(),
				hint: 'r',
				icon: IconRefreshCw,
				run: linkDispatch('link.reextract', id, false),
			},
			{
				id: 'link.copy-url',
				label: m.action_copy_url(),
				icon: IconCopy,
				run: linkDispatch('link.copy-url', id, true),
			},
		)
	}

	const filtersActive =
		url.q !== '' || url.state !== '' || url.category !== '' || url.host !== '' || url.stale
	if (filtersActive) {
		cmds.push({
			id: 'filters.clear',
			label: m.palette_clear_filters(),
			icon: IconFilterX,
			keywords: 'reset',
			run: () => deps.setUrl({ q: '', state: '', category: '', host: '', stale: false }),
		})
	}
	cmds.push({
		id: 'filters.stale',
		label: m.palette_toggle_stale(),
		icon: IconTimer,
		keywords: 'filter',
		run: () => deps.setUrl({ stale: !url.stale }),
	})

	const go = (view: ViewName) => () => deps.setUrl({ view, selected: null })
	cmds.push(
		{ id: 'view.triage', label: m.palette_go_triage(), icon: IconInbox, keywords: 'nav home inbox', run: go('triage') },
		{ id: 'view.attention', label: m.palette_go_attention(), icon: IconTriangleAlert, keywords: 'nav needs login blocked', run: go('attention') },
		{ id: 'view.run', label: m.palette_go_run(), icon: IconActivity, keywords: 'nav pipeline', run: go('run') },
		{ id: 'view.metrics', label: m.palette_go_metrics(), icon: IconChartColumn, keywords: 'nav stats usage', run: go('metrics') },
		{ id: 'view.settings', label: m.palette_go_settings(), icon: IconSettings, keywords: 'nav preferences config', run: go('settings') },
	)

	const LAYOUTS = [
		['right', m.layout_mode_right(), IconPanelRight],
		['bottom', m.layout_mode_bottom(), IconPanelBottom],
		['hidden', m.layout_mode_hidden(), IconEyeOff],
	] as const
	for (const [mode, name, icon] of LAYOUTS) {
		if (url.layout === mode) continue
		cmds.push({
			id: `layout.${mode}`,
			label: m.palette_layout_set({ layout: name }),
			icon,
			keywords: 'preview panel',
			run: () => deps.setUrl({ layout: mode }),
		})
	}

	const cur = get(density)
	const next = cur === 'compact' ? 'comfortable' : 'compact'
	cmds.push({
		id: 'prefs.density',
		label: m.palette_density_toggle({
			density: next === 'compact' ? m.density_compact() : m.density_comfortable(),
		}),
		icon: IconRows3,
		keywords: 'rows spacing',
		run: () => setDensity(next),
	})

	if (deps.openAssistant) {
		cmds.push({
			id: 'app.assistant',
			label: m.palette_assistant(),
			icon: IconSparkles,
			keywords: 'ai chat agent acp',
			hint: '⌘J',
			run: () => deps.openAssistant!(),
		})
	}

	cmds.push(
		{
			id: 'app.ingest',
			label: m.ingest_title(),
			hint: '+',
			icon: IconPlus,
			keywords: 'add save url',
			run: () => deps.setUrl({ dialog: 'ingest' }),
		},
		{
			id: 'app.run',
			label: m.palette_run_pipeline(),
			icon: IconPlay,
			keywords: 'enrich extract process',
			run: () => {
				void api
					.run()
					.then(() => deps.invalidate())
					.catch(() => {})
				deps.setUrl({ view: 'run', selected: null })
			},
		},
		{
			id: 'app.refresh',
			label: m.action_refresh(),
			icon: IconRefreshCw,
			keywords: 'reload data',
			run: () => deps.invalidate(),
		},
		{
			id: 'app.help',
			label: m.keymap_title(),
			hint: '?',
			icon: IconKeyboard,
			keywords: 'shortcuts keys',
			run: () => deps.setUrl({ dialog: 'help' }),
		},
	)

	if (q === '') return cmds
	return cmds
		.map((c) => ({ c, s: scoreCommand(c.label, c.keywords ?? '', q) + (c.boost ?? 0) }))
		.filter(({ s }) => s >= 0)
		.sort((a, b) => b.s - a.s)
		.map(({ c }) => c)
}
