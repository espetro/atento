import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { AcpClient, type AcpMcpServer } from "./acp";
import {
	ApplicationMenu,
	BrowserWindow,
	BrowserView,
	ContextMenu,
	Session,
	type ApplicationMenuItemConfig,
} from "electrobun/main";

// linkinbox desktop shell (Workstream B1).
//
// Dev: the window loads LINKINBOX_URL — `linkinbox serve` on :4173 serves
// the built packages/ui/dist plus the API (vite dev server :5173 while
// iterating on the UI).
//
// Packaged: LINKINBOX_URL is unset and Resources/server exists, so the
// shell spawns the bundled sidecar server (node binary + pnpm-deployed
// workspace + ui-dist) and loads it on 127.0.0.1. The sidecar exists
// because better-sqlite3 cannot run under this process's Bun runtime.
// resourcesDir() doubles as the packaged-mode check — in dev the exec
// path has no Resources/server sibling, so this stays inert.
//
// LINKINBOX_SELFTEST=partition-set | partition-check runs the D0 cookie
// persistence probe: main-process BrowserViews (same code path as
// <electrobun-webview>) load cookie set/check pages that beacon
// document.cookie back to a tiny collector. See README.md →
// "Verifying partition persistence".

const SELFTEST = process.env.LINKINBOX_SELFTEST ?? "";
const SELFTEST_PORT = Number(process.env.LINKINBOX_SELFTEST_PORT ?? "4799");

interface SidecarServer {
	url: string;
	port: number;
	proc: ReturnType<typeof Bun.spawn>;
}

const SIDECAR_PORTS = [4173, 4174, 4175];

function resourcesDir(): string | null {
	// Packaged: <App>.app/Contents/MacOS/<exe> -> ../Resources/server
	const candidate = join(dirname(process.execPath), "..", "Resources", "server");
	return existsSync(join(candidate, "server-entry.mjs")) ? candidate : null;
}

async function waitForServer(port: number, proc: SidecarServer["proc"], timeoutMs = 20000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/links?limit=1`);
			if (res.ok) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

async function startSidecar(): Promise<SidecarServer | null> {
	const dir = resourcesDir();
	if (dir === null) return null;
	for (const port of SIDECAR_PORTS) {
		let proc: SidecarServer["proc"];
		try {
			proc = Bun.spawn(
				[join(dir, "node"), join(dir, "server-entry.mjs")],
				{
					cwd: dir,
					env: {
						...process.env,
						LINKINBOX_PORT: String(port),
						LINKINBOX_UI_DIST: join(dir, "ui-dist"),
						LINKINBOX_PARENT_PID: String(process.pid),
					},
					stdout: "inherit",
					stderr: "inherit",
				},
			);
		} catch (e) {
			console.error(`[desktop] sidecar spawn failed on :${port}:`, e);
			continue;
		}
		if (await waitForServer(port, proc)) {
			console.log(`[desktop] sidecar server up on :${port}`);
			return { url: `http://127.0.0.1:${port}`, port, proc };
		}
		console.log(`[desktop] sidecar on :${port} failed to start, trying next port`);
		proc.kill();
	}
	return null;
}

const sidecar =
	process.env.LINKINBOX_URL === undefined ? await startSidecar() : null;
if (process.env.LINKINBOX_URL === undefined && sidecar === null) {
	console.error("[desktop] no LINKINBOX_URL and no sidecar server available");
}

const UI_URL = process.env.LINKINBOX_URL ?? sidecar?.url ?? "http://localhost:4173";

const mainWindow = new BrowserWindow({
	title: "linkinbox",
	url: UI_URL,
	frame: savedWindowFrame(),
});

console.log(`[desktop] window created, loading ${UI_URL}`);

process.on("exit", () => {
	sidecar?.proc.kill();
});

// ---------------------------------------------------------------------------
// ACP assistant (P3). The shell is the ACP client: it spawns the
// user-configured agent binary over stdio JSON-RPC, injects MCP tool
// servers into the session (the sidecar's streamable-HTTP /mcp plus a
// stdio ui-layout shim), and relays session traffic between the agent and
// the page over the localhost bridge — no new IPC mechanism.
//
// Agent selection is user config, never hardcoded: ~/.linkinbox/acp-agent.json
// ({ "command": ["claude-code-acp", ...] }) or LINKINBOX_ACP_COMMAND.
// ---------------------------------------------------------------------------

const ACP_CONFIG_PATH = join(homedir(), ".linkinbox", "acp-agent.json");
const WINDOW_BOUNDS_PATH = join(homedir(), ".linkinbox", "window.json");

type Frame = { x: number; y: number; width: number; height: number };

/** Last native window frame (written by the shell itself), or a default size. */
function savedWindowFrame(): Partial<Frame> & { width: number; height: number } {
	try {
		const f = JSON.parse(readFileSync(WINDOW_BOUNDS_PATH, "utf8")) as Partial<Frame>;
		if (
			[f.x, f.y, f.width, f.height].every((n) => typeof n === "number" && Number.isFinite(n)) &&
			f.width! >= 400 &&
			f.height! >= 300
		) {
			return f as Frame;
		}
	} catch {
		// first launch
	}
	return { width: 1280, height: 820 };
}

let boundsTimer: ReturnType<typeof setTimeout> | undefined;
function persistWindowFrame(): void {
	clearTimeout(boundsTimer);
	boundsTimer = setTimeout(() => {
		try {
			mkdirSync(dirname(WINDOW_BOUNDS_PATH), { recursive: true });
			writeFileSync(WINDOW_BOUNDS_PATH, JSON.stringify(mainWindow.getFrame()));
		} catch {
			// best effort
		}
	}, 400);
}
mainWindow.on("resize", persistWindowFrame);
mainWindow.on("move", persistWindowFrame);

// Known ACP clients. Probed on PATH (augmented — packaged apps get a minimal
// PATH without homebrew/user bin dirs). First detected agent becomes the
// default when the user has no explicit config.
const ACP_AGENTS = [
	{ id: "claude", label: "Claude Code", command: ["claude-code-acp"] },
	{ id: "codex", label: "Codex", command: ["codex-acp"] },
	{ id: "agy", label: "Agy", command: ["agy", "acp"] },
	{ id: "maki", label: "Maki", command: ["maki", "acp"] },
] as const;

const EXTRA_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	join(homedir(), ".local", "bin"),
	join(homedir(), ".bun", "bin"),
	join(homedir(), ".npm-global", "bin"),
	join(homedir(), ".nix-profile", "bin"),
];

function whichBin(name: string): string | null {
	try {
		return Bun.which(name, {
			PATH: [...EXTRA_PATHS, process.env.PATH ?? ""].join(":"),
		});
	} catch {
		return null;
	}
}

interface AcpAgentInfo {
	id: string;
	label: string;
	command: string[];
	path: string;
}

function detectAgents(): AcpAgentInfo[] {
	const out: AcpAgentInfo[] = [];
	for (const a of ACP_AGENTS) {
		const path = whichBin(a.command[0]);
		if (path !== null) out.push({ ...a, command: [...a.command], path });
	}
	return out;
}

function acpCommand(): string[] | null {
	try {
		const raw = readFileSync(ACP_CONFIG_PATH, "utf8");
		const cfg = JSON.parse(raw) as { command?: unknown };
		if (Array.isArray(cfg.command) && cfg.command.length > 0) {
			return cfg.command.map(String);
		}
	} catch {
		// no config file
	}
	const env = process.env["LINKINBOX_ACP_COMMAND"];
	if (env !== undefined && env.trim() !== "") {
		return env.trim().split(/\s+/);
	}
	const found = detectAgents()[0];
	return found ? found.command : null;
}

function saveAcpCommand(command: string[]) {
	mkdirSync(dirname(ACP_CONFIG_PATH), { recursive: true });
	writeFileSync(ACP_CONFIG_PATH, JSON.stringify({ command }, null, 2));
}

interface AcpSession {
	client: AcpClient;
	sessionId: string;
}
let acpSession: AcpSession | null = null;
let acpError = "";
const permissionWaiters = new Map<string, (outcome: unknown) => void>();
let permissionSeq = 0;

function forwardAcpEvent(payload: unknown) {
	evalInPage(
		`window.dispatchEvent(new CustomEvent("linkinbox:acp-event",{detail:${JSON.stringify(payload)}}))`,
	);
}

function acpMcpServers(): AcpMcpServer[] {
	const servers: AcpMcpServer[] = [
		// The app's own link tools — streamable HTTP on the sidecar.
		{ name: "linkinbox", url: `${UI_URL}/mcp` },
	];
	// ui-layout: stdio shim that relays GenUI tools to the page via /layout/tool.
	const dir = resourcesDir();
	const shim =
		dir !== null
			? join(dir, "mcp-ui-layout.mjs")
			: join(import.meta.dir, "..", "..", "mcp-ui-layout.mjs");
	const nodeBin = dir !== null ? join(dir, "node") : "node";
	servers.push({
		name: "ui-layout",
		command: nodeBin,
		args: [shim],
		env: { LINKINBOX_BRIDGE: SHELL_BRIDGE_URL },
	});
	return servers;
}

async function ensureAcp(): Promise<AcpSession> {
	if (acpSession !== null) return acpSession;
	const cmd = acpCommand();
	if (cmd === null) throw new Error("no agent configured");
	acpError = "";
	const resolved = whichBin(cmd[0]!) ?? cmd[0]!;
	const { client, sessionId } = await AcpClient.spawn([resolved, ...cmd.slice(1)], {
		cwd: homedir(),
		mcpServers: acpMcpServers(),
	});
	client.onNotification = (method, params) => {
		if (method === "session/update") forwardAcpEvent(params);
	};
	client.onRequest = (method, params, respond) => {
		if (method === "session/request_permission") {
			const reqId = `perm-${++permissionSeq}`;
			permissionWaiters.set(reqId, respond);
			evalInPage(
				`window.dispatchEvent(new CustomEvent("linkinbox:acp-permission",{detail:${JSON.stringify({ requestId: reqId, params })}}))`,
			);
			return;
		}
		// Other agent→client requests (fs, terminal) — politely decline.
		respond({});
	};
	acpSession = { client, sessionId };
	return acpSession;
}

function dropAcp(err: string) {
	acpSession?.client.kill();
	acpSession = null;
	acpError = err;
}

// Pending layout tool calls: the shim POSTs here, the request round-trips
// through the page (gen/catalog lives in the UI), and /layout/result resolves.
const layoutWaiters = new Map<
	string,
	{ resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();
let layoutSeq = 0;

async function layoutTool(tool: string, args: unknown): Promise<unknown> {
	const requestId = `layout-${++layoutSeq}`;
	const promise = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			layoutWaiters.delete(requestId);
			reject(new Error("layout tool timed out — is the page loaded?"));
		}, 8000);
		layoutWaiters.set(requestId, { resolve, timer });
	});
	evalInPage(
		`window.dispatchEvent(new CustomEvent("linkinbox:layout-request",{detail:${JSON.stringify({ requestId, tool, args })}}))`,
	);
	return promise;
}

// ---------------------------------------------------------------------------
// App menubar + context menus.
//
// The menubar gives the shell the standard macOS menus (app/edit/view/window/
// help) — the Edit roles matter because the UI has text inputs. Custom actions
// arrive as { action, data } on "application-menu-clicked".
//
// The hosted page is remote, so Electrobun's preload exposes no RPC global to
// it. Right-click menus therefore go through a tiny localhost bridge: the page
// POSTs the menu spec, we showContextMenu() at the pointer, and the chosen
// action is forwarded back into the page as a `linkinbox:menu-action`
// CustomEvent via executeJavascript.
// ---------------------------------------------------------------------------

const shellBridge = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (req) => {
		const cors = {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "POST, OPTIONS",
			"access-control-allow-headers": "content-type",
		};
		if (req.method === "OPTIONS") return new Response(null, { headers: cors });
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path === "/context-menu") {
			try {
				const body = (await req.json()) as { items?: unknown };
				if (Array.isArray(body.items)) {
					ContextMenu.showContextMenu(body.items as ApplicationMenuItemConfig[]);
				}
			} catch {
				// malformed payload — ignore
			}
			return new Response("ok", { headers: cors });
		}
		// ---- ACP ---------------------------------------------------------------
		if (path === "/acp/status" && req.method === "GET") {
			return Response.json(
				{
					configured: acpCommand() !== null,
					connected: acpSession !== null,
					sessionId: acpSession?.sessionId ?? null,
					error: acpError,
				},
				{ headers: cors },
			);
		}
		if (path === "/acp/agents" && req.method === "GET") {
			return Response.json(
				{ configured: acpCommand(), available: detectAgents() },
				{ headers: cors },
			);
		}
		if (path === "/acp/config" && req.method === "POST") {
			try {
				const body = (await req.json()) as { command?: unknown };
				if (!Array.isArray(body.command) || body.command.length === 0) {
					return new Response("bad command", { status: 400, headers: cors });
				}
				saveAcpCommand(body.command.map(String));
				dropAcp("");
				return Response.json({ ok: true }, { headers: cors });
			} catch (e) {
				return new Response(String(e), { status: 400, headers: cors });
			}
		}
		if (path === "/acp/prompt" && req.method === "POST") {
			try {
				const body = (await req.json()) as { text?: unknown };
				const text = typeof body.text === "string" ? body.text : "";
				if (text.trim() === "") {
					return new Response("empty prompt", { status: 400, headers: cors });
				}
				const session = await ensureAcp();
				// Prompt is async: updates stream back via linkinbox:acp-event.
				void session.client
					.request("session/prompt", {
						sessionId: session.sessionId,
						prompt: [{ type: "text", text }],
					})
					.then((result) => forwardAcpEvent({ sessionUpdate: "end_turn", result }))
					.catch((e) => {
						forwardAcpEvent({ sessionUpdate: "error", error: String(e) });
						dropAcp(String(e));
					});
				return Response.json({ ok: true }, { headers: cors });
			} catch (e) {
				return Response.json({ ok: false, error: String(e) }, { status: 502, headers: cors });
			}
		}
		if (path === "/acp/cancel" && req.method === "POST") {
			acpSession?.client.notify("session/cancel", { sessionId: acpSession.sessionId });
			return Response.json({ ok: true }, { headers: cors });
		}
		if (path === "/acp/permission" && req.method === "POST") {
			try {
				const body = (await req.json()) as { requestId?: unknown; optionId?: unknown };
				const respond = permissionWaiters.get(String(body.requestId));
				if (respond === undefined) {
					return new Response("no such request", { status: 404, headers: cors });
				}
				permissionWaiters.delete(String(body.requestId));
				respond({ outcome: { outcome: "selected", optionId: String(body.optionId ?? "") } });
				return Response.json({ ok: true }, { headers: cors });
			} catch (e) {
				return new Response(String(e), { status: 400, headers: cors });
			}
		}
		// ---- GenUI layout tools (MCP ui-layout shim) ----------------------------
		if (path === "/layout/tool" && req.method === "POST") {
			try {
				const body = (await req.json()) as { tool?: unknown; args?: unknown };
				if (typeof body.tool !== "string") {
					return new Response("bad tool", { status: 400, headers: cors });
				}
				const result = await layoutTool(body.tool, body.args ?? {});
				return Response.json(result ?? {}, { headers: cors });
			} catch (e) {
				return Response.json({ error: String(e) }, { status: 504, headers: cors });
			}
		}
		if (path === "/layout/result" && req.method === "POST") {
			try {
				const body = (await req.json()) as { requestId?: unknown; result?: unknown };
				const waiter = layoutWaiters.get(String(body.requestId));
				if (waiter === undefined) {
					return new Response("no such request", { status: 404, headers: cors });
				}
				layoutWaiters.delete(String(body.requestId));
				clearTimeout(waiter.timer);
				waiter.resolve(body.result ?? null);
				return Response.json({ ok: true }, { headers: cors });
			} catch (e) {
				return new Response(String(e), { status: 400, headers: cors });
			}
		}
		return new Response("not found", { status: 404, headers: cors });
	},
});
const SHELL_BRIDGE_URL = `http://127.0.0.1:${shellBridge.port}`;

function evalInPage(js: string) {
	try {
		mainWindow.webview.executeJavascript(js);
	} catch (e) {
		console.error("[desktop] page eval failed:", e);
	}
}

// Tell the hosted page where the bridge lives. did-commit-navigation lands
// before the SPA's module scripts evaluate (so first render already sees it);
// dom-ready is the fallback if the early eval has no document yet.
for (const evt of ["did-commit-navigation", "dom-ready"] as const) {
	mainWindow.webview.on(evt, () => {
		evalInPage(`window.__linkinboxBridge=${JSON.stringify(SHELL_BRIDGE_URL)};`);
	});
}

function forwardMenuAction(action: string, data: unknown) {
	const detail = JSON.stringify({ action, data: data ?? null });
	evalInPage(
		`window.dispatchEvent(new CustomEvent("linkinbox:menu-action",{detail:${detail}}))`,
	);
}

ContextMenu.on("context-menu-clicked", (event: unknown) => {
	const e = event as { action?: string; data?: unknown };
	if (typeof e.action === "string" && e.action !== "") {
		forwardMenuAction(e.action, e.data);
	}
});

// Set a single URL search param without dropping the rest of the state,
// then ping the SPA's popstate listener (same trick as the dom-probe).
function navigatePageParam(key: string, value: string) {
	evalInPage(
		`(()=>{const u=new URL(location.href);u.searchParams.set(${JSON.stringify(key)},${JSON.stringify(value)});history.pushState(null,"",u.search);dispatchEvent(new PopStateEvent("popstate"))})()`,
	);
}

ApplicationMenu.setApplicationMenu([
	{
		// First unlabeled submenu becomes the macOS app menu.
		submenu: [
			{ label: "About linkinbox", role: "about" },
			{ type: "separator" },
			{
				label: "Settings…",
				action: "app.settings",
				accelerator: "CommandOrControl+,",
			},
			{ type: "separator" },
			{ label: "Hide linkinbox", role: "hide" },
			{ label: "Hide Others", role: "hideOthers" },
			{ label: "Show All", role: "showAll" },
			{ type: "separator" },
			{
				label: "Quit linkinbox",
				role: "quit",
				accelerator: "CommandOrControl+Q",
			},
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ type: "separator" },
			{ role: "selectAll" },
		],
	},
	{
		label: "View",
		submenu: [
			{
				label: "Reload",
				action: "view.reload",
				accelerator: "CommandOrControl+R",
			},
			{ type: "separator" },
			{ role: "toggleFullScreen" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ type: "separator" },
			{ label: "Close Window", role: "close", accelerator: "CommandOrControl+W" },
			{ type: "separator" },
			{ role: "bringAllToFront" },
		],
	},
	{
		label: "Help",
		submenu: [
			{
				label: "linkinbox Help",
				action: "app.help",
				accelerator: "CommandOrControl+/",
			},
		],
	},
]);

ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
	const e = event as { action?: string };
	switch (e.action) {
		case "view.reload":
			mainWindow.webview.loadURL(UI_URL);
			break;
		case "app.settings":
			navigatePageParam("view", "settings");
			break;
		case "app.help":
			navigatePageParam("dialog", "help");
			break;
	}
});

mainWindow.webview.on("did-navigate", (event: unknown) => {
	console.log("[desktop] did-navigate", JSON.stringify(event).slice(0, 200));
});

// ---------------------------------------------------------------------------
// D0 self-test: partition persistence probe (dev only, opt-in via env).
// ---------------------------------------------------------------------------

const BASE = `http://localhost:${SELFTEST_PORT}`;

// [label, partition passed to BrowserView (null = no partition attr)]
const PROBES: Array<[string, string | null]> = [
	["persist", "persist:linkinbox-d0test"],
	["eph", "linkinbox-d0ephemeral"],
	["default", null],
];

function startCollector() {
	Bun.serve({
		port: SELFTEST_PORT,
		fetch(req) {
			const url = new URL(req.url);
			const cors = { "access-control-allow-origin": "*" };
			if (url.pathname === "/log") {
				console.log(
					`[selftest] ${url.searchParams.get("label")}: ${url.searchParams.get("result")}`,
				);
				return new Response("ok", { headers: cors });
			}
			if (url.pathname === "/set") {
				const name = url.searchParams.get("name") ?? "ck";
				const value = url.searchParams.get("value") ?? "1";
				return new Response(`<html><body>cookie set: ${name}=${value}</body></html>`, {
					headers: {
						"content-type": "text/html",
						"set-cookie": `${name}=${value}; Path=/; Max-Age=86400`,
						...cors,
					},
				});
			}
			if (url.pathname === "/cookies") {
				const who = url.searchParams.get("who") ?? "anon";
				return new Response(
					`<!doctype html><title>cookies-${who}</title><pre id="c">pending</pre><script>
						const c = document.cookie || "(none)";
						document.getElementById("c").textContent = c;
						fetch("/log?label=cookies-${who}&result=" + encodeURIComponent(c)).catch(() => {});
					</script>`,
					{ headers: { "content-type": "text/html", ...cors } },
				);
			}
			return new Response("collector", { status: 200, headers: cors });
		},
	});
	console.log(`[selftest] collector on :${SELFTEST_PORT}`);
}

function mkProbeView(partition: string | null, url: string): BrowserView {
	return new BrowserView({
		url,
		html: null,
		preload: null,
		viewsRoot: null,
		allowedProtocols: { views: false, appData: false },
		renderer: "native",
		partition,
		frame: { x: 0, y: 0, width: 10, height: 10 },
		hostWebviewId: mainWindow.webviewId,
		windowId: mainWindow.id,
		autoResize: false,
		navigationRules: null,
		sandbox: true,
		startTransparent: false,
		startPassthrough: false,
		spellCheck: false,
	});
}

function dumpSessionCookies(label: string) {
	for (const [name, partition] of PROBES) {
		const p = partition ?? "";
		try {
			const cookies = Session.fromPartition(p || "persist:default").cookies.get({});
			console.log(`[selftest] session-${label} ${name}(${p || "null"}): ${JSON.stringify(cookies)}`);
		} catch (e) {
			console.log(`[selftest] session-${label} ${name} ERROR:`, e);
		}
	}
}

function runPartitionSet() {
	startCollector();
	const views: BrowserView[] = [];
	const cookieName: Record<string, string> = {
		persist: "ckP",
		eph: "ckE",
		default: "ckD",
	};
	const cookieValue: Record<string, string> = {
		persist: "persist1",
		eph: "eph1",
		default: "default1",
	};
	for (const [label, partition] of PROBES) {
		try {
			const v = mkProbeView(
				partition,
				`${BASE}/set?name=${cookieName[label]}&value=${cookieValue[label]}`,
			);
			views.push(v);
			console.log(`[selftest] view created ${label} partition=${partition ?? "null"} id=${v.id}`);
		} catch (e) {
			console.log(`[selftest] view create ${label} ERROR:`, e);
		}
	}
	// After the /set pages load, re-navigate each to its /cookies page.
	setTimeout(() => {
		PROBES.forEach(([label], i) => {
			const v = views[i];
			if (v) {
				console.log(`[selftest] ${label} -> cookies check page`);
				v.loadURL(`${BASE}/cookies?who=${label}-set`);
			}
		});
	}, 8000);
	// Session API cross-check, then graceful quit so WebKit flushes stores.
	setTimeout(() => {
		dumpSessionCookies("set");
		console.log("[selftest] partition-set done — quitting for flush");
		mainWindow.close();
	}, 16000);
}

function runPartitionCheck() {
	startCollector();
	const views: BrowserView[] = [];
	for (const [label, partition] of PROBES) {
		try {
			const v = mkProbeView(partition, `${BASE}/cookies?who=${label}-check`);
			views.push(v);
			console.log(`[selftest] view created ${label} partition=${partition ?? "null"} id=${v.id}`);
		} catch (e) {
			console.log(`[selftest] view create ${label} ERROR:`, e);
		}
	}
	setTimeout(() => {
		dumpSessionCookies("check");
		console.log("[selftest] partition-check done — quitting");
		mainWindow.close();
	}, 10000);
}

// dom-probe: verifies the UI mounted <electrobun-webview> pool elements.
// Page timers/rAF stall in occluded windows, so this injects once and
// beacons immediately — element presence + attributes are the signal;
// native init is covered by the partition selftest.
function runDomProbe() {
	startCollector();
	const inject = () => {
		const js = `(async () => {
			const B = (l, r) => fetch("${BASE}/log?label=" + encodeURIComponent(l) + "&result=" + encodeURIComponent(String(r))).catch(() => {});
			const els = [...document.querySelectorAll("electrobun-webview")];
			B("dom-probe-count", els.length);
			B("dom-probe-slot", !!document.querySelector('[data-testid="native-preview"]'));
			B("dom-probe-reader", !!document.querySelector('[data-testid="reader-markdown"], [data-testid="snapshot-img"], [data-testid="preview-empty-state"]'));
			for (const [i, el] of els.entries()) {
				const r = el.getBoundingClientRect();
				B("dom-probe-el-" + i, JSON.stringify({
					partition: el.getAttribute("partition"),
					sandbox: el.hasAttribute("sandbox"),
					src: el.getAttribute("src"),
					webviewId: el.webviewId,
					rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
				}));
			}
		})();`;
		try {
			mainWindow.webview.executeJavascript(js);
			console.log("[selftest] dom-probe injected");
		} catch (e) {
			console.log("[selftest] dom-probe inject failed:", e);
		}
	};
	mainWindow.webview.on("dom-ready", () => setTimeout(inject, 4000));
	// Retry a few times: the Svelte app + link detail fetch need a moment,
	// and occluded windows throttle timers anyway — later probes are freshest.
	mainWindow.webview.on("did-navigate", () => {
		for (const ms of [12000, 22000, 35000]) setTimeout(inject, ms);
	});
	// Optional pool check: switch the selection to a second link (different
	// host) mid-run, then keep probing — expect 2 pooled webview elements.
	const select2 = process.env.LINKINBOX_PROBE_SELECT2;
	if (select2) {
		mainWindow.webview.on("did-navigate", () => {
			setTimeout(() => {
				try {
					mainWindow.webview.executeJavascript(
						`history.pushState(null, "", "?selected=${select2}"); dispatchEvent(new PopStateEvent("popstate"));`,
					);
					console.log(`[selftest] dom-probe switched selection to ${select2}`);
				} catch (e) {
					console.log("[selftest] select2 failed:", e);
				}
			}, 15000);
			for (const ms of [30000, 45000]) setTimeout(inject, ms);
		});
	}
}

if (SELFTEST === "partition-set") {
	runPartitionSet();
} else if (SELFTEST === "partition-check") {
	runPartitionCheck();
} else if (SELFTEST === "dom-probe") {
	runDomProbe();
} else if (SELFTEST !== "") {
	console.warn(`[desktop] unknown LINKINBOX_SELFTEST value: ${SELFTEST}`);
}
