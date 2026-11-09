// Minimal ACP (Agent Client Protocol) client over stdio JSON-RPC 2.0.
//
// Deliberately dependency-free: the desktop bundle has no node_modules to
// reach for, and ACP is a line-delimited JSON-RPC protocol — a hand-rolled
// client stays debuggable against any agent binary. Shapes follow
// @agentclientprotocol/sdk: `initialize`, `session/new`, `session/prompt`,
// `session/cancel`, plus the agent→client `session/request_permission`
// request and `session/update` notifications.

export interface AcpMcpServerStdio {
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
}
export interface AcpMcpServerHttp {
	name: string;
	url: string;
	headers?: Record<string, string>;
}
export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp;

export interface AcpSessionInfo {
	cwd: string;
	mcpServers: AcpMcpServer[];
}

type Json = Record<string, unknown>;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}

export class AcpClient {
	private proc: ReturnType<typeof Bun.spawn>;
	private seq = 0;
	private pending = new Map<number, Pending>();
	private buf = "";
	/** Raw agent→client notifications (session/update etc.). */
	onNotification: (method: string, params: unknown) => void = () => {};
	/** Agent→client requests we can't answer locally (fs, permissions). */
	onRequest: (method: string, params: unknown, respond: (result: unknown) => void) => void =
		(_m, _p, respond) => respond({});

	private constructor(proc: ReturnType<typeof Bun.spawn>) {
		this.proc = proc;
		void this.pump();
	}

	static async spawn(
		cmd: string[],
		session: AcpSessionInfo,
	): Promise<{ client: AcpClient; sessionId: string }> {
		const proc = Bun.spawn(cmd, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: process.env,
		});
		const client = new AcpClient(proc);
		await client.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: "linkinbox-desktop", version: "0.1.0" },
		});
		const res = (await client.request("session/new", {
			cwd: session.cwd,
			mcpServers: session.mcpServers,
		})) as { sessionId: string };
		return { client, sessionId: res.sessionId };
	}

	private async pump() {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			this.buf += dec.decode(value, { stream: true });
			let idx: number;
			while ((idx = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, idx).trim();
				this.buf = this.buf.slice(idx + 1);
				if (line !== "") this.onLine(line);
			}
		}
		this.failAll(new Error("agent process exited"));
	}

	private onLine(line: string) {
		let msg: Json;
		try {
			msg = JSON.parse(line) as Json;
		} catch {
			return;
		}
		const id = msg["id"];
		if (typeof id === "number" && ("result" in msg || "error" in msg)) {
			const p = this.pending.get(id);
			this.pending.delete(id);
			if (p === undefined) return;
			if ("error" in msg) p.reject(msg["error"]);
			else p.resolve(msg["result"]);
			return;
		}
		if (typeof msg["method"] === "string") {
			if (id !== undefined && id !== null) {
				// Agent→client request: must be answered with a result.
				const reqId = id as number | string;
				this.onRequest(msg["method"] as string, msg["params"], (result) => {
					this.send({ jsonrpc: "2.0", id: reqId, result });
				});
			} else {
				this.onNotification(msg["method"] as string, msg["params"]);
			}
		}
	}

	private send(obj: Json) {
		try {
			(this.proc.stdin as { write: (s: string) => void }).write(`${JSON.stringify(obj)}\n`);
		} catch {
			// agent gone
		}
	}

	private failAll(err: unknown) {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	kill() {
		try {
			this.proc.kill();
		} catch {
			// already dead
		}
	}
}
