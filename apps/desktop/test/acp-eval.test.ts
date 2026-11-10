import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AcpClient } from "../src/bun/acp";

/**
 * Eval tests: prove an ACP agent can (a) complete the protocol handshake,
 * (b) retrieve linkinbox data, and (c) take CRUD actions — here against a
 * mock linkinbox API that records what the agent did.
 */
describe("ACP agent eval", () => {
	test("agent retrieves data and performs a CRUD ingest", async () => {
		// Mock linkinbox API the stub agent talks to.
		const calls: { method: string; path: string; body: string }[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				const body = req.method === "GET" ? "" : await req.text();
				calls.push({ method: req.method, path: url.pathname, body });
				if (url.pathname === "/api/links") {
					return Response.json({ items: [{ id: "l1", url: "https://a.com" }], total: 1 });
				}
				if (url.pathname === "/api/ingest") {
					return Response.json({ ok: true, id: "new-1" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		const api = `http://127.0.0.1:${server.port}`;
		const stub = join(import.meta.dir, "fixtures", "fake-agent.mjs");

		const { client, sessionId } = await AcpClient.spawn(
			[Bun.which("bun")!, stub],
			{ cwd: "/tmp", mcpServers: [] },
			{ env: { LINKINBOX_API: api } },
		);
		expect(sessionId).toBe("fake-session-1");

		const updates: string[] = [];
		client.onNotification = (_m, params) => {
			const p = params as { update?: { content?: { text?: string } } };
			if (p.update?.content?.text) updates.push(p.update.content.text);
		};

		const result = (await client.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "do the eval" }],
		})) as { stopReason: string };

		expect(result.stopReason).toBe("end_turn");
		// Retrieve: agent listed links.
		expect(calls.some((c) => c.method === "GET" && c.path === "/api/links")).toBe(true);
		// CRUD: agent ingested a link.
		expect(calls.some((c) => c.method === "POST" && c.path === "/api/ingest")).toBe(true);
		// Streaming updates arrived in order.
		expect(updates.join("")).toContain("read 1 links");
		expect(updates.join("")).toContain("ingest 200");

		client.kill();
		server.stop();
	}, 15_000);
});
