import * as v from 'valibot'

/**
 * GenUI catalog (P2.1): view layouts are data — a tree of `UIElement` nodes
 * rendered by `gen/Renderer.svelte`. Generic node types render natively;
 * view-specific types (`previewPanel`, `metadataPanel`) resolve through the
 * component's `parts` snippet map. No eval, no generated code — `action`
 * props are opaque ids resolved by the host view.
 */

export interface UIElement {
	id?: string
	type: string
	props?: Record<string, unknown>
	children?: UIElement[]
}

const elementSchema: v.GenericSchema<UIElement> = v.lazy(() =>
	v.object({
		id: v.optional(v.string()),
		type: v.string(),
		props: v.optional(v.record(v.string(), v.unknown())),
		children: v.optional(v.array(elementSchema)),
	}),
)

/** Per-type props schemas. Unknown types must carry no meaningful props. */
const PROPS_SCHEMAS: Record<string, v.GenericSchema> = {
	section: v.object({
		title: v.optional(v.string()),
		note: v.optional(v.string()),
	}),
	twoColumn: v.object({
		cols: v.optional(v.picklist(['2', '3', '4'])),
	}),
	markdown: v.object({ text: v.string() }),
	button: v.object({
		label: v.string(),
		action: v.string(),
		variant: v.optional(v.picklist(['default', 'primary', 'danger', 'ghost'])),
	}),
	metric: v.object({
		title: v.string(),
		value: v.string(),
		description: v.optional(v.string()),
		delta: v.optional(v.string()),
		trend: v.optional(v.picklist(['up', 'down', 'neutral'])),
	}),
	chips: v.object({
		items: v.array(v.object({ label: v.string(), tone: v.optional(v.string()) })),
	}),
	toolbar: v.object({}),
	previewPanel: v.object({}),
	metadataPanel: v.object({}),
	rowList: v.object({}),
}

/** Node types safe to emit to an LLM as the component catalog. */
export const CATALOG_TYPES = Object.keys(PROPS_SCHEMAS)

function nodeOk(node: UIElement): boolean {
	const schema = PROPS_SCHEMAS[node.type]
	// Unknown node types are tolerated only when they carry no props —
	// app-provided parts render them; stray props indicate junk payloads.
	if (!schema) {
		return (node.props == null || Object.keys(node.props).length === 0) &&
			(node.children ?? []).every(nodeOk)
	}
	return v.safeParse(schema, node.props ?? {}).success && (node.children ?? []).every(nodeOk)
}

/**
 * Validate a layout tree. Returns the cleaned node list (nodes whose props
 * fail their schema are dropped), or null when the input isn't a node array.
 */
export function parseLayout(input: unknown): UIElement[] | null {
	const res = v.safeParse(v.array(elementSchema), input)
	if (!res.success) return null
	return res.output.filter(nodeOk)
}
