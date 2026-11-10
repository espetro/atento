import { BrowserWindow } from "electrobun/main";

// SPIKE: load the atento web UI (served by `atento serve`) directly.
const UI_URL = process.env.ATENTO_UI_URL ?? "http://localhost:4173";
const COLLECTOR = process.env.SPIKE_COLLECTOR ?? "http://localhost:4799";

const mainWindow = new BrowserWindow({
	title: "atento — electrobun spike",
	url: UI_URL,
	frame: {
		width: 1280,
		height: 800,
	},
});

console.log(`[spike] window created, loading ${UI_URL}`);

// Run JS in the top webview; the script itself beacons results to the collector.
function drive(js: string) {
	try {
		mainWindow.webview.executeJavascript(js);
	} catch (e) {
		console.log("[spike] executeJavascript failed:", e);
	}
}

mainWindow.webview.on("did-navigate", (event: unknown) => {
	console.log("[spike] did-navigate", JSON.stringify(event).slice(0, 200));
});
mainWindow.webview.on("dom-ready", () => {
	console.log("[spike] dom-ready");
	// Let the Svelte app mount, then run the scenario inside the page.
	setTimeout(() => drive(process.env.SPIKE_MODE === "check-cookies" ? COOKIES_SCENARIO : SCENARIO), 2500);
});

// Everything below runs inside the atento page (http://localhost:4173).
const SCENARIO = `(async () => {
	const B = (l, r) => fetch("${COLLECTOR}/log?label=" + encodeURIComponent(l) + "&result=" + encodeURIComponent(String(r))).catch(() => {});
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

	// ---------- S2: embedded preview webview injected into the app DOM ----------
	B("s2-custom-element", customElements.get("electrobun-webview") ? "registered" : "MISSING");

	const panel = document.createElement("div");
	panel.id = "spike-preview-panel";
	panel.style.cssText =
		"position:fixed;right:0;top:0;width:500px;height:700px;z-index:2147483000;" +
		"background:#0f172a;color:#e2e8f0;font:12px/1.4 monospace;padding:4px;box-sizing:border-box;";
	panel.innerHTML = "<div style='padding:2px 4px'>SPIKE preview pane (electrobun-webview)</div>";
	const wv = document.createElement("electrobun-webview");
	wv.style.cssText = "display:block;width:100%;height:calc(100% - 22px)";
	wv.setAttribute("src", "https://example.com");
	panel.appendChild(wv);
	document.body.appendChild(panel);

	B("s2-injected", JSON.stringify({
		rect: rect(wv),
		hasLoadURL: typeof wv.loadURL,
		hasOn: typeof wv.on,
		webviewId: wv.webviewId,
	}));

	if (typeof wv.on === "function") {
		for (const ev of ["dom-ready", "did-navigate", "load-finished", "will-navigate", "new-window-open"]) {
			wv.on(ev, (e) => B("wv1-" + ev, JSON.stringify(e && e.detail).slice(0, 300)));
		}
	} else {
		B("s2-no-on-method", "electrobun-webview element lacks .on()");
	}

	await sleep(6000);

	// Host page drives the webview: simulate selection change.
	try {
		wv.loadURL("https://github.com");
		B("s2-loadURL-called", "https://github.com");
	} catch (e) {
		B("s2-loadURL-error", String(e));
	}
	await sleep(6000);

	// Geometry: fixed panel should not move on host scroll; record anchor rects.
	const rBefore = rect(wv);
	window.scrollTo(0, Math.min(400, document.body.scrollHeight - innerHeight));
	await sleep(700);
	const rAfter = rect(wv);
	B("s2-scroll-sync", JSON.stringify({ before: rBefore, after: rAfter, scrollY: Math.round(window.scrollY) }));
	window.scrollTo(0, 0);

	// In-flow variant: does the anchor track layout inside scrolling content?
	const flow = document.createElement("div");
	flow.style.cssText = "height:3000px;";
	const spacer = document.createElement("div");
	spacer.style.cssText = "height:1500px";
	const flowWv = document.createElement("electrobun-webview");
	flowWv.setAttribute("src", "https://example.org");
	flowWv.style.cssText = "display:block;width:400px;height:300px";
	flow.appendChild(spacer);
	flow.appendChild(flowWv);
	document.body.appendChild(flow);
	if (typeof flowWv.on === "function") {
		for (const ev of ["dom-ready", "did-navigate", "load-finished"]) {
			flowWv.on(ev, (e) => B("wvFlow-" + ev, JSON.stringify(e && e.detail).slice(0, 200)));
		}
	}
	await sleep(4000);
	const fBefore = rect(flowWv);
	window.scrollTo(0, 1200);
	await sleep(700);
	const fAfter = rect(flowWv);
	B("s2-flow-scroll", JSON.stringify({ before: fBefore, after: fAfter, expectedDY: 1200 - (fBefore.y - fAfter.y), scrollY: Math.round(window.scrollY) }));
	window.scrollTo(0, 0);

	// ---------- S3: sandbox attr + per-host partitions + cookie persistence ----
	// wv2: sandboxed, partition pool-b -> example.org
	const wv2 = document.createElement("electrobun-webview");
	wv2.setAttribute("sandbox", "");
	wv2.setAttribute("partition", "pool-b");
	wv2.setAttribute("src", "https://example.org");
	wv2.style.cssText = "position:fixed;left:0;bottom:0;width:300px;height:400px;z-index:2147483000;background:#fff;";
	document.body.appendChild(wv2);
	if (typeof wv2.on === "function") {
		for (const ev of ["dom-ready", "did-navigate", "load-finished"]) {
			wv2.on(ev, (e) => B("wv2-" + ev, JSON.stringify(e && e.detail).slice(0, 200)));
		}
	}
	B("s3-wv2-created", JSON.stringify({ id: wv2.webviewId, partition: wv2.getAttribute("partition"), sandbox: wv2.hasAttribute("sandbox") }));
	await sleep(5000);

	// Cookie test on default partition (wv) and pool-b (wv2), via collector server.
	wv.loadURL("http://localhost:4799/set?name=ckDefault&value=spike1");
	wv2.loadURL("http://localhost:4799/set?name=ckB&value=poolb");
	await sleep(4000);
	wv.loadURL("http://localhost:4799/cookies?who=default");
	wv2.loadURL("http://localhost:4799/cookies?who=B");
	await sleep(4000);

	// Pool concept: third tag, different partition, same session-independent load.
	const wv3 = document.createElement("electrobun-webview");
	wv3.setAttribute("partition", "pool-a");
	wv3.setAttribute("src", "https://example.com");
	wv3.style.cssText = "position:fixed;left:320px;bottom:0;width:300px;height:300px;z-index:2147483000;background:#fff;";
	document.body.appendChild(wv3);
	if (typeof wv3.on === "function") {
		wv3.on("dom-ready", () => B("wv3-dom-ready", "pool-a alive"));
	}
	await sleep(4000);
	B("s3-done", JSON.stringify({ wv1: wv.webviewId, wv2: wv2.webviewId, wv3: wv3.webviewId }));
})();`;

// SPIKE_MODE=check-cookies: after an app restart, verify cookies set in the
// previous run persisted in the default and named partitions.
const COOKIES_SCENARIO = `(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const mk = (partition, who, style) => {
		const el = document.createElement("electrobun-webview");
		if (partition) el.setAttribute("partition", partition);
		el.setAttribute("src", "${COLLECTOR}/cookies?who=" + who);
		el.style.cssText = style;
		document.body.appendChild(el);
		return el;
	};
	mk(null, "default-after-restart", "position:fixed;right:0;top:0;width:300px;height:300px;z-index:2147483000;");
	mk("pool-b", "B-after-restart", "position:fixed;right:320px;top:0;width:300px;height:300px;z-index:2147483000;");
	mk("pool-a", "A-after-restart", "position:fixed;right:640px;top:0;width:300px;height:300px;z-index:2147483000;");
	await sleep(6000);
})();`;
