import type { ElectrobunConfig } from "electrobun";

// atento desktop shell.
//
// The window loads the running atento server (dev: `atento serve` on
// :4173, which serves packages/ui/dist + the API). No bundled views are
// needed — the whole UI is the remote page, and <electrobun-webview> tags it
// creates are composited natively by Electrobun.
export default {
	app: {
		name: "Atento",
		identifier: "dev.atento.app",
		version: "0.1.1",
		description: "Atento: a link inbox that triages itself",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"server-runtime/server.tar.gz": "server.tar.gz",
		},
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
		},
		linux: {
			bundleCEF: false,
			icon: "icon.png",
		},
		win: {
			bundleCEF: false,
			icon: "icon-win.png",
		},
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
} satisfies ElectrobunConfig;
