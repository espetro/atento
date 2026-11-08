import { BrowserWindow, BrowserView, Session } from "electrobun/main";

// linkinbox desktop shell (Workstream B1).
//
// The window loads the running linkinbox server — `linkinbox serve` on
// :4173 serves the built packages/ui/dist plus the API. Override with
// LINKINBOX_URL (e.g. the vite dev server on :5173 while iterating on the UI).
//
// LINKINBOX_SELFTEST=partition-set | partition-check runs the D0 cookie
// persistence probe: main-process BrowserViews (same code path as
// <electrobun-webview>) load cookie set/check pages that beacon
// document.cookie back to a tiny collector. See README.md →
// "Verifying partition persistence".

const UI_URL = process.env.LINKINBOX_URL ?? "http://localhost:4173";
const SELFTEST = process.env.LINKINBOX_SELFTEST ?? "";
const SELFTEST_PORT = Number(process.env.LINKINBOX_SELFTEST_PORT ?? "4799");

const mainWindow = new BrowserWindow({
	title: "linkinbox",
	url: UI_URL,
	frame: {
		width: 1440,
		height: 900,
	},
});

console.log(`[desktop] window created, loading ${UI_URL}`);

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

if (SELFTEST === "partition-set") {
	runPartitionSet();
} else if (SELFTEST === "partition-check") {
	runPartitionCheck();
} else if (SELFTEST !== "") {
	console.warn(`[desktop] unknown LINKINBOX_SELFTEST value: ${SELFTEST}`);
}
