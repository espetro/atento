import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrowserWindow, BrowserView, Session } from "electrobun/main";

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
	frame: {
		width: 1440,
		height: 900,
	},
});

console.log(`[desktop] window created, loading ${UI_URL}`);

process.on("exit", () => {
	sidecar?.proc.kill();
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
