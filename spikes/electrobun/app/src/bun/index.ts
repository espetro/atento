import { BrowserWindow } from "electrobun/main";

// SPIKE S1: load the linkinbox web UI (served by `linkinbox serve`) directly.
const UI_URL = process.env.LINKINBOX_UI_URL ?? "http://localhost:4173";

const mainWindow = new BrowserWindow({
	title: "linkinbox — electrobun spike",
	url: UI_URL,
	frame: {
		width: 1280,
		height: 800,
	},
});

console.log(`[spike] window created, loading ${UI_URL}`);

// Verification helper: run JS in the top webview and beacon the result to a
// local collector so we can assert rendering headlessly.
const COLLECTOR = process.env.SPIKE_COLLECTOR ?? "http://localhost:4799";

async function probe(label: string, js: string) {
	try {
		mainWindow.webview.executeJavascript(`(async () => {
			try {
				const result = await (${js});
				await fetch("${COLLECTOR}/log?label=${encodeURIComponent(label)}&result=" + encodeURIComponent(String(result))).catch(() => {});
			} catch (e) {
				await fetch("${COLLECTOR}/log?label=${encodeURIComponent(label)}&result=" + encodeURIComponent("ERR:" + e)).catch(() => {});
			}
		})()`);
	} catch (e) {
		console.log(`[spike] probe ${label} failed:`, e);
	}
}

mainWindow.webview.on("did-navigate", (event: unknown) => {
	console.log("[spike] did-navigate", event);
});
mainWindow.webview.on("dom-ready", () => {
	console.log("[spike] dom-ready");
	// Give the Svelte app a moment to mount, then probe the DOM.
	setTimeout(async () => {
		await probe(
			"ui-mount",
			`(() => {
				const app = document.querySelector("#app");
				return JSON.stringify({
					title: document.title,
					appChildren: app ? app.children.length : -1,
					appHTMLLen: app ? app.innerHTML.length : -1,
					bodyText: document.body.innerText.slice(0, 200),
					hasElectrobunWebview: !!customElements.get("electrobun-webview"),
					origin: location.origin,
					lsKeys: Object.keys(localStorage),
				});
			})()`,
		);
	}, 2500);
});
