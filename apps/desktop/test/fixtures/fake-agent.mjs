// Fake ACP agent for eval tests: speaks line-delimited JSON-RPC on stdio.
// On session/prompt it performs a CRUD action against the atento API
// ($ATENTO_API — proves the agent can act on real data), streams two
// session/update notifications back, then resolves the prompt.

const api = process.env.ATENTO_API ?? "http://127.0.0.1:4173";

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

let buf = "";
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.trim() === "") continue;
		const msg = JSON.parse(line);
		if (msg.id === undefined) continue; // notifications: ignore
		if (msg.method === "initialize") {
			reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
		} else if (msg.method === "session/new") {
			reply(msg.id, { sessionId: "fake-session-1" });
		} else if (msg.method === "session/prompt") {
			// Retrieve data: list links (read), then CRUD: ingest a link (write).
			void (async () => {
				try {
					const links = await fetch(`${api}/api/links?limit=1`).then((r) =>
						r.json(),
					);
					send({
						jsonrpc: "2.0",
						method: "session/update",
						params: {
							sessionId: "fake-session-1",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: `read ${links.items?.length ?? 0} links; ` },
							},
						},
					});
					const ing = await fetch(`${api}/api/ingest`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ url: "https://example.com/acp-eval" }),
					});
					send({
						jsonrpc: "2.0",
						method: "session/update",
						params: {
							sessionId: "fake-session-1",
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: `ingest ${ing.status}` },
							},
						},
					});
					reply(msg.id, { stopReason: "end_turn" });
				} catch (e) {
					reply(msg.id, { stopReason: "end_turn", error: String(e) });
				}
			})();
		} else {
			reply(msg.id, {});
		}
	}
});
