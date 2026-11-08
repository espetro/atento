/**
 * Desktop shell bridge (Workstream B1).
 *
 * When the UI runs inside the Electrobun desktop shell, Electrobun's preload
 * registers an <electrobun-webview> custom element on the hosted page. We use
 * it to render a real native webview (WKWebView on macOS) in the preview
 * slot, with a per-host warm pool so login/cookie state survives selections.
 *
 * On plain web (browser, jsdom, vitest) `isDesktopShell()` is false and none
 * of this code runs — the reader/snapshot fallback in PreviewPane is used.
 *
 * Partition semantics (verified against Electrobun 2.0.6 sources, see
 * /tmp/linkinbox-desktop-partitions.md):
 *   - `partition="persist:<key>"` → persistent per-partition data store
 *     (WKWebsiteDataStore dataStoreForIdentifier on macOS 14+, CEF cached
 *     request context on Linux/Windows).
 *   - any other partition → ephemeral in-memory store.
 *   - no partition → the shared default store (all webviews share cookies).
 * We use `persist:` so per-host logins survive app restarts.
 */

/** Minimal typing for the Electrobun webview tag (avoids an electrobun dep). */
export interface ElectrobunWebviewTag extends HTMLElement {
	webviewId: number | null
	loadURL(url: string): void
	loadHTML(html: string): void
	reload(): void
	goBack(): void
	goForward(): void
	canGoBack(): Promise<boolean>
	canGoForward(): Promise<boolean>
	toggleHidden(hidden?: boolean): void
	toggleTransparent(transparent?: boolean): void
	togglePassthrough(passthrough?: boolean): void
	setNavigationRules(rules: string[]): void
	on(event: string, listener: (event: CustomEvent) => void): void
	off(event: string, listener: (event: CustomEvent) => void): void
	executeJavascript(js: string): void
}

/**
 * True when running inside the Electrobun shell. The custom element is
 * registered by Electrobun's preload on every hosted page (verified in the
 * B0 spike), so its presence is the capability check — no `window.electrobun`
 * global exists on remote pages.
 */
export function isDesktopShell(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof customElements !== 'undefined' &&
		customElements.get('electrobun-webview') != null
	)
}

/** Pool key: the lowercase hostname, falling back to the raw URL. */
export function hostKeyForUrl(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase()
	} catch {
		return url
	}
}

/** Sanitize a host key for use inside a `persist:` partition string. */
export function partitionForHost(host: string): string {
	const safe = host.replace(/[^a-z0-9.-]+/gi, '_')
	return `persist:linkinbox-${safe}`
}

const POOL_MAX = 8

interface PoolEntry {
	el: ElectrobunWebviewTag
	/** Last URL requested via showNativePreview; used to skip redundant loads. */
	url: string
	lastUsed: number
}

const pool = new Map<string, PoolEntry>()

function evictLru() {
	let oldestKey: string | null = null
	let oldest = Infinity
	for (const [key, entry] of pool) {
		if (entry.lastUsed < oldest) {
			oldest = entry.lastUsed
			oldestKey = key
		}
	}
	if (oldestKey !== null) {
		const entry = pool.get(oldestKey)
		entry?.el.remove()
		pool.delete(oldestKey)
	}
}

/**
 * Apply hidden state to every pooled webview: only `activeHost` is visible.
 * `toggleHidden` is a no-op until the native view assigns a webviewId
 * (async), so we retry a few times for freshly created entries.
 */
function applyVisibility(activeHost: string) {
	for (const [host, entry] of pool) {
		const wantHidden = host !== activeHost
		if (entry.el.webviewId !== null) {
			entry.el.toggleHidden(wantHidden)
		}
	}
}

// Bumped on every showNativePreview/reset so stale visibility retries
// scheduled for a previous selection bail instead of hiding the new
// active webview during rapid selection changes.
let visibilityGen = 0

function scheduleVisibilityRetries(activeHost: string, gen: number) {
	for (const delay of [100, 400, 1200]) {
		setTimeout(() => {
			if (gen === visibilityGen) applyVisibility(activeHost)
		}, delay)
	}
}

/**
 * Show `url` in `container`: reuses the host's pooled webview (creating it
 * on first sight with a persistent per-host partition + sandbox), keeps all
 * pool entries mounted inside the container stacked on top of each other,
 * and hides the inactive ones natively.
 *
 * Entries live inside `container` for the component's lifetime; when the
 * preview unmounts, `resetNativePreviewPool()` destroys them (removing an
 * <electrobun-webview> from the DOM tears down its native view — cookies
 * still persist via the partition).
 */
export function showNativePreview(container: HTMLElement, url: string) {
	const host = hostKeyForUrl(url)

	let entry = pool.get(host)
	if (!entry) {
		if (pool.size >= POOL_MAX) evictLru()
		const el = document.createElement(
			'electrobun-webview',
		) as unknown as ElectrobunWebviewTag
		el.setAttribute('sandbox', '')
		el.setAttribute('partition', partitionForHost(host))
		el.className = 'native-preview-wv'
		entry = { el, url: '', lastUsed: 0 }
		pool.set(host, entry)
		container.appendChild(el)
	}

	entry.lastUsed = Date.now()

	// Reparenting an <electrobun-webview> destroys and recreates its native
	// view, so only move the element if the container actually changed.
	if (entry.el.parentElement !== container) {
		container.appendChild(entry.el)
	}

	const gen = ++visibilityGen
	applyVisibility(host)
	scheduleVisibilityRetries(host, gen)

	if (entry.url !== url) {
		entry.url = url
		entry.el.loadURL(url)
	}
}

/** Destroy the whole pool (called when the preview component unmounts). */
export function resetNativePreviewPool() {
	visibilityGen++
	for (const entry of pool.values()) {
		entry.el.remove()
	}
	pool.clear()
}
