import { derived, writable, type Readable } from 'svelte/store'
import { parseLayout, type UIElement } from './catalog'

/**
 * Per-view layout state (P2.3). Defaults live in code; user (or agent, via
 * the ui-layout MCP tool in P3) overrides persist in localStorage keyed by
 * view. `viewLayout` is reactive: setLayout/resetLayout re-render consumers.
 */

const KEY_PREFIX = 'linkinbox:layout:'

const overrides = writable<Record<string, UIElement[]>>({})

function storageGet(view: string): UIElement[] | null {
	try {
		const raw = localStorage.getItem(KEY_PREFIX + view)
		if (raw == null) return null
		return parseLayout(JSON.parse(raw))
	} catch {
		return null
	}
}

/** Reactive layout for `view`: override → stored → default, in that order. */
export function viewLayout(view: string, def: UIElement[]): Readable<UIElement[]> {
	return derived(overrides, ($o) => $o[view] ?? storageGet(view) ?? def)
}

/** Validate + persist a layout override. Returns false for malformed input. */
export function setLayout(view: string, nodes: unknown): boolean {
	const parsed = parseLayout(nodes)
	if (!parsed) return false
	overrides.update((o) => ({ ...o, [view]: parsed }))
	try {
		localStorage.setItem(KEY_PREFIX + view, JSON.stringify(parsed))
	} catch {
		/* private mode */
	}
	return true
}

/** Drop the override — the view falls back to its default schema. */
export function resetLayout(view: string): void {
	overrides.update((o) => {
		const next = { ...o }
		delete next[view]
		return next
	})
	try {
		localStorage.removeItem(KEY_PREFIX + view)
	} catch {
		/* private mode */
	}
}
