#!/usr/bin/env node
// Package the atento desktop app for the current platform (CI only, see the
// repo AGENTS.md): builds the sidecar server runtime, builds the Electrobun
// app with hutch, and writes
//   dist-release/Atento-desktop-<version>-<os>-<arch>.{zip,tar.gz}
//
// Plain TypeScript for Node >= 24 (type stripping), no shell, so it runs the
// same on macOS, Linux and Windows.
//
// The server runtime is packed into the app by electrobun.config.ts
// (build.copy) as server.tar.gz, because build.copy flattens symlinks and
// the self-extracting wrapper re-extracts Resources on first run. The shell
// unpacks it into ~/.atento/runtime on first launch. Contents of the tarball:
//   server/node[.exe]            self-contained Node, same ABI as the build
//   server/server-entry.mjs      sidecar entry point
//   server/ui-dist/              built packages/ui
//   server/{dist,node_modules}/  pnpm-deployed @atento/cli
//
// The sidecar exists because better-sqlite3 cannot run under the Bun runtime
// that hosts the Electrobun main process.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP_DIR, "..", "..");
const RUNTIME = join(APP_DIR, "server-runtime");
const BUILD = join(APP_DIR, "build");
const OUT = join(REPO, "dist-release");

const isWin = process.platform === "win32";
const OS = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
const ARCH = { arm64: "arm64", x64: "x64" }[process.arch as string];
if (!OS || !ARCH) throw new Error(`unsupported platform ${process.platform}-${process.arch}`);

const version = (JSON.parse(readFileSync(join(REPO, "packages/atento/package.json"), "utf8")) as { version: string }).version;

function run(cmd: string, args: string[], cwd = REPO): void {
	// pnpm is a .cmd shim on Windows, which Node only spawns through a shell.
	execFileSync(cmd, args, { cwd, stdio: "inherit", shell: isWin && cmd === "pnpm" });
}

function firstDir(root: string, pick: (name: string) => boolean): string | undefined {
	const hit = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory() && pick(e.name));
	return hit && join(root, hit.name);
}

function findBundle(): string {
	if (OS === "darwin") {
		for (const sub of readdirSync(BUILD)) {
			const dir = join(BUILD, sub);
			const app = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith(".app")) : undefined;
			if (app) return join(dir, app);
		}
	}
	const dir = firstDir(BUILD, (n) => n.startsWith("stable-"));
	if (!dir) throw new Error(`no app bundle under ${BUILD}: ${readdirSync(BUILD).join(", ")}`);
	return dir;
}

if (!existsSync(join(REPO, "packages/ui/dist/index.html"))) {
	throw new Error("packages/ui/dist is missing, run `pnpm build` first");
}

console.log("==> deploying server bundle");
const server = join(RUNTIME, "server");
rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(server, { recursive: true });
// Windows: hoisted layout, so node_modules holds real directories instead of
// junctions that archivers handle inconsistently. The bundled node is the
// node running this script, which is also the one pnpm installed
// better-sqlite3 for, so the ABI matches without a rebuild.
const linker = isWin ? ["--config.node-linker=hoisted"] : [];
run("pnpm", ["--filter", "@atento/cli", "deploy", "--prod", ...linker, server]);
copyFileSync(join(APP_DIR, "server-entry.mjs"), join(server, "server-entry.mjs"));
copyFileSync(join(APP_DIR, "mcp-ui-layout.mjs"), join(server, "mcp-ui-layout.mjs"));
cpSync(join(REPO, "packages/ui/dist"), join(server, "ui-dist"), { recursive: true });
const nodeName = isWin ? "node.exe" : "node";
copyFileSync(process.execPath, join(server, nodeName));
chmodSync(join(server, nodeName), 0o755);
// Relative paths and cwd: GNU tar reads "C:\..." as a remote host.
execFileSync("tar", ["-czf", "server.tar.gz", "server"], { cwd: RUNTIME, stdio: "inherit" });

console.log("==> building electrobun app");
rmSync(BUILD, { recursive: true, force: true });
run("hutch", ["run", "build"], APP_DIR);

mkdirSync(OUT, { recursive: true });
const base = `Atento-desktop-${version}-${OS}-${ARCH}`;

if (OS === "darwin") {
	// Ship the inner app bundle, not the self-extracting wrapper: the wrapper's
	// first-run installer shows an "<App> Setup" progress window, which is
	// pure friction for a drag-to-Applications zip. The payload archive is the
	// same runnable .app the wrapper would install.
	const payload = readdirSync(join(APP_DIR, "artifacts")).find(
		(n) => n.startsWith(`stable-macos-${ARCH}-`) && n.endsWith(".app.tar.zst"),
	);
	if (!payload) {
		throw new Error(`no stable-macos-${ARCH} payload in apps/desktop/artifacts`);
	}
	const stage = mkdtempSync(join(tmpdir(), "atento-pkg-"));
	try {
		execFileSync("tar", ["-xf", join(APP_DIR, "artifacts", payload)], { cwd: stage, stdio: "inherit" });
		const inner = join(stage, "Atento.app");
		if (!existsSync(inner)) throw new Error(`payload did not contain Atento.app`);
		console.log("==> ad-hoc signing");
		try {
			execFileSync("codesign", ["--force", "--deep", "--sign", "-", inner], { stdio: "inherit" });
		} catch {
			console.warn("codesign failed, continuing unsigned");
		}
		execFileSync("ditto", ["-c", "-k", "--keepParent", inner, join(OUT, `${base}.zip`)], { stdio: "inherit" });
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
} else {
	const bundle = findBundle();
	console.log(`==> bundle: ${bundle}`);
	const parent = dirname(bundle);
	const name = bundle.slice(parent.length + 1);
	if (OS === "windows") {
		// bsdtar ships with Windows 10+ and writes zip with -a.
		execFileSync("tar", ["-a", "-c", "-f", `${base}.zip`, name], { cwd: parent, stdio: "inherit" });
		copyFileSync(join(parent, `${base}.zip`), join(OUT, `${base}.zip`));
		rmSync(join(parent, `${base}.zip`));
	} else {
		execFileSync("tar", ["-czf", join(OUT, `${base}.tar.gz`), name], { cwd: parent, stdio: "inherit" });
	}
}
console.log(`==> ${OUT}`);
