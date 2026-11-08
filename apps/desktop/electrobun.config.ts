import type { ElectrobunConfig } from "electrobun";

// linkinbox desktop shell.
//
// The window loads the running linkinbox server (dev: `linkinbox serve` on
// :4173, which serves packages/ui/dist + the API). No bundled views are
// needed — the whole UI is the remote page, and <electrobun-webview> tags it
// creates are composited natively by Electrobun.
export default {
	app: {
		name: "linkinbox",
		identifier: "dev.linkinbox.app",
		version: "0.1.0",
		description: "linkinbox — link triage pipeline",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
} satisfies ElectrobunConfig;
