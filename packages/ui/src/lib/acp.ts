import { hasShellBridge } from './desktop'
import { CATALOG_TYPES, type UIElement } from '../gen/catalog'
import { resetLayout, setLayout, viewLayout } from '../gen/layout'

/**
 * ACP assistant bridge client (P3.2/P3.4).
 *
 * The Electrobun shell owns the agent subprocess + ACP session; the page
 * talks to it through the same localhost bridge the native menus use.
 * Agent traffic arrives as CustomEvents:
 *   atento:acp-event       — session/update payloads + end_turn/error
 *   atento:acp-permission  — permission prompts to approve in-page
 *   atento:layout-request  — ui-layout MCP tool calls to answer here
 * All of this is inert on plain web (no bridge → no events, calls no-op).
 */

export interface AcpStatus {
	configured: boolean
	connected: boolean
	sessionId: string | null
	error: string
}

function bridge(): string | null {
	const w = window as unknown as { __atentoBridge?: string }
	return typeof w.__atentoBridge === 'string' ? w.__atentoBridge : null
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const base = bridge()
	if (base === null) throw new Error('no shell bridge')
	const res = await fetch(`${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`bridge ${res.status}`)
	return (await res.json()) as T
}

/** True when the shell reports an ACP backend (agent may be unconfigured). */
export async function acpAvailable(): Promise<boolean> {
	if (!hasShellBridge()) return false
	try {
		const res = await fetch(`${bridge()}/acp/status`)
		return res.ok
	} catch {
		return false
	}
}

export async function acpStatus(): Promise<AcpStatus | null> {
	const base = bridge()
	if (base === null) return null
	try {
		const res = await fetch(`${base}/acp/status`)
		return res.ok ? ((await res.json()) as AcpStatus) : null
	} catch {
		return null
	}
}

export interface AcpProbe {
	ok: boolean
	at: number
	ms: number
	error?: string
	agent?: { name?: string; version?: string }
	protocolVersion?: number
	authMethods?: { id: string; name?: string }[]
	models?: { current: string | null; available: { modelId: string; name?: string; description?: string }[] }
	modes?: { current: string | null; available: { id: string; name?: string }[] }
}

export interface AcpAgent {
	id: string
	label: string
	command: string[]
	/** Resolved binary path; null when not installed. */
	path: string | null
	custom: boolean
	enabled: boolean
	active: boolean
	/** Preferred model id, applied when a session starts. */
	model: string | null
	probe: AcpProbe | null
}

export interface AcpAgents {
	configured: string[] | null
	agents: AcpAgent[]
}

/** Every known agent (installed or not) plus the configured command; null on plain web. */
export async function acpAgents(): Promise<AcpAgents | null> {
	const base = bridge()
	if (base === null) return null
	try {
		const res = await fetch(`${base}/acp/agents`)
		return res.ok ? await res.json() : null
	} catch {
		return null
	}
}

export interface AcpConfigPatch {
	/** Make this command the active agent. */
	command?: string[]
	id?: string
	enabled?: boolean
	/** Preferred model for `id`; empty string clears it. */
	model?: string
	custom?: { id?: string; label?: string; command: string[] }
	removeCustom?: string
}

export function acpConfigure(patch: AcpConfigPatch | string[]) {
	return post('/acp/config', Array.isArray(patch) ? { command: patch } : patch)
}

/** Spawn the agent, run initialize + session/new, and report what it advertises. */
export function acpTest(id: string) {
	return post<AcpProbe>('/acp/test', { id })
}

export function acpPrompt(text: string) {
	return post<{ ok: boolean; error?: string }>('/acp/prompt', { text })
}

export function acpCancel() {
	return post('/acp/cancel', {})
}

export function acpPermission(requestId: string, optionId: string) {
	return post('/acp/permission', { requestId, optionId })
}

/** Subscribe to session/update payloads. Returns unsubscribe. */
export function onAcpEvent(handler: (update: unknown) => void): () => void {
	const listener = (e: Event) => handler((e as CustomEvent<unknown>).detail)
	window.addEventListener('atento:acp-event', listener)
	return () => window.removeEventListener('atento:acp-event', listener)
}

export interface AcpPermissionRequest {
	requestId: string
	params: unknown
}

/** Subscribe to agent permission requests. Returns unsubscribe. */
export function onAcpPermission(handler: (req: AcpPermissionRequest) => void): () => void {
	const listener = (e: Event) => handler((e as CustomEvent<AcpPermissionRequest>).detail)
	window.addEventListener('atento:acp-permission', listener)
	return () => window.removeEventListener('atento:acp-permission', listener)
}

// ---- ui-layout tool serving -------------------------------------------------
//
// The MCP shim calls the bridge, the bridge relays here, we answer with the
// gen/* modules and POST the result back. Current layouts come from the same
// defaults the views register — kept in a map the views write into.

const viewDefaults = new Map<string, UIElement[]>()
const viewCurrent = new Map<string, UIElement[]>()

/** Views register their default schema so the tools can read it. */
export function registerLayoutView(view: string, def: UIElement[]): void {
	viewDefaults.set(view, def)
	// Track effective layout for get_layout (viewLayout wraps defaults).
	const sub = viewLayout(view, def).subscribe((nodes) => {
		viewCurrent.set(view, nodes)
	})
	// Register-once semantics; unsubscribe only on re-registration.
	void sub
}

async function runLayoutTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
	const view = typeof args.view === 'string' ? args.view : 'preview'
	switch (tool) {
		case 'list_catalog':
			return { view, types: CATALOG_TYPES }
		case 'get_layout':
			return { view, nodes: viewCurrent.get(view) ?? viewDefaults.get(view) ?? null }
		case 'update_layout': {
			const ok = setLayout(view, args.nodes)
			return ok ? { ok: true, view } : { ok: false, error: 'layout failed validation' }
		}
		case 'reset_layout':
			resetLayout(view)
			return { ok: true, view }
		default:
			return { error: `unknown tool ${tool}` }
	}
}

/**
 * Answer `atento:layout-request` events by running the tool and posting
 * the result back to the bridge. Wire once (App mount).
 */
export function startLayoutToolServer(): () => void {
	const listener = (e: Event) => {
		const { requestId, tool, args } = (e as CustomEvent<{
			requestId: string
			tool: string
			args: Record<string, unknown>
		}>).detail
		void runLayoutTool(tool, args ?? {}).then((result) => {
			void post('/layout/result', { requestId, result }).catch(() => {})
		})
	}
	window.addEventListener('atento:layout-request', listener)
	return () => window.removeEventListener('atento:layout-request', listener)
}
