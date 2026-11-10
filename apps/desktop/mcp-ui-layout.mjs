#!/usr/bin/env node
// Minimal MCP stdio server exposing the app's GenUI surface to ACP agents.
// Dependency-free: line-delimited JSON-RPC over stdio; tool calls are
// forwarded to the shell's localhost bridge ($ATENTO_BRIDGE) which
// relays them into the hosted page — the UI's gen/catalog + gen/layout
// modules remain the source of truth.

const BRIDGE = process.env.ATENTO_BRIDGE ?? "";

const TOOLS = [
	{
		name: "list_catalog",
		description:
			"List the UI component catalog: node types and prop schemas the layout tree may use.",
		inputSchema: { type: "object", properties: { view: { type: "string" } } },
	},
	{
		name: "get_layout",
		description: "Get the current layout tree for a view.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" } },
			required: ["view"],
		},
	},
	{
		name: "update_layout",
		description:
			"Replace a view's layout tree. Nodes must come from list_catalog; unknown types need a registered part.",
		inputSchema: {
			type: "object",
			properties: {
				view: { type: "string" },
				nodes: { type: "array", items: { type: "object" } },
			},
			required: ["view", "nodes"],
		},
	},
	{
		name: "reset_layout",
		description: "Reset a view's layout to its built-in default.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string" } },
			required: ["view"],
		},
	},
];

function send(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function result(id, res) {
	send({ jsonrpc: "2.0", id, result: res });
}
function textResult(id, data) {
	result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
}
function toolError(id, message) {
	result(id, { content: [{ type: "text", text: `error: ${message}` }], isError: true });
}

async function forward(tool, args) {
	const res = await fetch(`${BRIDGE}/layout/tool`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tool, args }),
	});
	if (!res.ok) throw new Error(`bridge ${res.status}`);
	return res.json();
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
	buf += chunk;
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (line === "") continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		await handle(msg);
	}
});

async function handle(msg) {
	const { id, method, params } = msg;
	if (method === "initialize") {
		result(id, {
			protocolVersion: params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "atento-ui-layout", version: "0.1.0" },
		});
		return;
	}
	if (method === "notifications/initialized" || method === "ping") {
		if (id !== undefined && method === "ping") result(id, {});
		return;
	}
	if (method === "tools/list") {
		result(id, { tools: TOOLS });
		return;
	}
	if (method === "tools/call") {
		if (BRIDGE === "") return toolError(id, "ATENTO_BRIDGE unset");
		const name = params?.name;
		if (!TOOLS.some((t) => t.name === name)) return toolError(id, `unknown tool ${name}`);
		try {
			const out = await forward(name, params?.arguments ?? {});
			textResult(id, out);
		} catch (e) {
			toolError(id, String(e?.message ?? e));
		}
		return;
	}
	if (id !== undefined) {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
	}
}
