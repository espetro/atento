#!/usr/bin/env bash
# Package the linkinbox desktop app: builds the sidecar server runtime,
# builds the Electrobun .app, injects Contents/Resources/server, ad-hoc
# signs, and installs to ~/Applications.
#
# Layout inside the .app:
#   Contents/Resources/server/node                  self-contained Node 26
#   Contents/Resources/server/server-entry.mjs      sidecar entry point
#   Contents/Resources/server/ui-dist/              built packages/ui
#   Contents/Resources/server/{dist,node_modules}/  pnpm-deployed @linkinbox/cli
#
# The sidecar exists because better-sqlite3 cannot run under the Bun
# runtime that hosts the Electrobun main process.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP_DIR/../.." && pwd)"
RUNTIME="$APP_DIR/server-runtime"
NODE_BIN="${LINKINBOX_NODE_BIN:-$(mise where node@26 2>/dev/null)/bin/node}"

[ -x "$NODE_BIN" ] || { echo "node binary not found: $NODE_BIN" >&2; exit 1; }
[ -f "$REPO/packages/ui/dist/index.html" ] || {
	echo "packages/ui/dist missing — run: pnpm --filter @linkinbox/ui build" >&2
	exit 1
}

echo "==> deploying server bundle"
rm -rf "$RUNTIME/server"
mkdir -p "$RUNTIME/server"
pnpm --dir "$REPO" --filter @linkinbox/cli deploy --prod "$RUNTIME/server"

# better-sqlite3's native module must match the bundled node's ABI — the
# deploy above runs under the system node, so rebuild against $NODE_BIN.
BSQ_DIR=$(find "$RUNTIME/server/node_modules/.pnpm" -maxdepth 3 -type d -name better-sqlite3 | head -1)
if [ -n "$BSQ_DIR" ]; then
	# mise's `npm` is a shell-script shim — can't be run via `node npm`.
	# Prefer the real npm-cli.js when present, else invoke the shim on PATH.
	NPM_CLI="$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"
	if [ -f "$NPM_CLI" ]; then
		PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" "$NPM_CLI" --prefix "$BSQ_DIR" rebuild 2>&1 | tail -2
	else
		PATH="$(dirname "$NODE_BIN"):$PATH" npm --prefix "$BSQ_DIR" rebuild 2>&1 | tail -2
	fi
fi

cp "$APP_DIR/server-entry.mjs" "$RUNTIME/server/"
cp "$APP_DIR/mcp-ui-layout.mjs" "$RUNTIME/server/"
cp -R "$REPO/packages/ui/dist" "$RUNTIME/server/ui-dist"
cp "$NODE_BIN" "$RUNTIME/server/node"
chmod +x "$RUNTIME/server/node"

echo "==> building electrobun app"
cd "$APP_DIR"
export PATH="$HOME/.hutch/bin:$PATH"
hutch run build

APP="$(find "$APP_DIR/build" -maxdepth 3 -name "*.app" | head -1)"
[ -n "$APP" ] || { echo "no .app produced under $APP_DIR/build" >&2; exit 1; }

echo "==> injecting server runtime into $APP"
mkdir -p "$APP/Contents/Resources"
rm -rf "$APP/Contents/Resources/server"
cp -R "$RUNTIME/server" "$APP/Contents/Resources/server"
chmod +x "$APP/Contents/Resources/server/node"

echo "==> ad-hoc signing"
codesign --force --deep --sign - "$APP" 2>&1 | tail -2 || true

echo "==> installing to ~/Applications"
rm -rf "$HOME/Applications/linkinbox.app"
cp -R "$APP" "$HOME/Applications/linkinbox.app"

# cp -R of ~400MB has been observed to truncate; verify and retry once.
if [ ! -f "$HOME/Applications/linkinbox.app/Contents/Resources/server/server-entry.mjs" ]; then
	echo "==> install copy incomplete, retrying server runtime"
	rm -rf "$HOME/Applications/linkinbox.app/Contents/Resources/server"
	cp -R "$APP/Contents/Resources/server" "$HOME/Applications/linkinbox.app/Contents/Resources/server"
fi
[ -f "$HOME/Applications/linkinbox.app/Contents/Resources/server/server-entry.mjs" ] || {
	echo "server runtime missing after install" >&2
	exit 1
}
chmod +x "$HOME/Applications/linkinbox.app/Contents/Resources/server/node"

echo "done: ~/Applications/linkinbox.app"
