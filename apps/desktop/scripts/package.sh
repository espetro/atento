#!/usr/bin/env bash
# Package the atento desktop app: builds the sidecar server runtime,
# builds the Electrobun .app, injects Contents/Resources/server, ad-hoc
# signs, and installs to ~/Applications.
#
#   package.sh              build and install to ~/Applications
#   package.sh --release    build and write dist-release/Atento-<version>-<os>-<arch>.{zip,tar.gz}
#                           (no install; used by the release workflow)
#
# Layout inside the .app:
#   Contents/Resources/server/node                  self-contained Node 26
#   Contents/Resources/server/server-entry.mjs      sidecar entry point
#   Contents/Resources/server/ui-dist/              built packages/ui
#   Contents/Resources/server/{dist,node_modules}/  pnpm-deployed @atento/cli
#
# The sidecar exists because better-sqlite3 cannot run under the Bun
# runtime that hosts the Electrobun main process.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP_DIR/../.." && pwd)"
RUNTIME="$APP_DIR/server-runtime"
MODE="${1:-install}"
VERSION="$(node -p "require('$REPO/packages/atento/package.json').version")"
case "$(uname -s)" in Darwin) OS=darwin ;; *) OS=linux ;; esac
case "$(uname -m)" in arm64 | aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
# Dev machines bundle node 26 (ABI-rebuilt below); CI bundles the node it built with.
NODE_BIN="${ATENTO_NODE_BIN:-$(mise where node@26 2>/dev/null)/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

[ -x "$NODE_BIN" ] || { echo "node binary not found: $NODE_BIN" >&2; exit 1; }
[ -f "$REPO/packages/ui/dist/index.html" ] || {
	echo "packages/ui/dist missing — run: pnpm --filter @atento/ui build" >&2
	exit 1
}

echo "==> deploying server bundle"
rm -rf "$RUNTIME/server"
mkdir -p "$RUNTIME/server"
pnpm --dir "$REPO" --filter @atento/cli deploy --prod "$RUNTIME/server"

# better-sqlite3's native module must match the bundled node's ABI — the
# deploy above runs under the system node, so rebuild against $NODE_BIN.
BSQ_DIR=$(find "$RUNTIME/server/node_modules/.pnpm" -maxdepth 3 -type d -name better-sqlite3 | head -1)
if [ -n "$BSQ_DIR" ] && [ "$NODE_BIN" != "$(command -v node)" ]; then
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
if [ -n "$APP" ]; then
	RES="$APP/Contents/Resources"
else
	# Linux: the bundle is a directory with a Resources folder next to the launcher.
	APP="$(find "$APP_DIR/build" -maxdepth 2 -type d -name "stable-*" | head -1)"
	RES="$(find "$APP" -maxdepth 3 -type d -name Resources | head -1)"
fi
[ -n "$APP" ] && [ -n "$RES" ] || { echo "no app bundle produced under $APP_DIR/build" >&2; exit 1; }

echo "==> injecting server runtime into $APP"
rm -rf "$RES/server"
cp -R "$RUNTIME/server" "$RES/server"
chmod +x "$RES/server/node"

if [ "$OS" = darwin ]; then
	echo "==> ad-hoc signing"
	codesign --force --deep --sign - "$APP" 2>&1 | tail -2 || true
fi

if [ "$MODE" = "--release" ]; then
	OUT="$REPO/dist-release"
	mkdir -p "$OUT"
	if [ "$OS" = darwin ]; then
		ditto -c -k --keepParent "$APP" "$OUT/Atento-$VERSION-$OS-$ARCH.zip"
	else
		tar -C "$(dirname "$APP")" -czf "$OUT/Atento-$VERSION-$OS-$ARCH.tar.gz" "$(basename "$APP")"
	fi
	echo "==> $OUT"
	exit 0
fi

echo "==> installing to ~/Applications"
rm -rf "$HOME/Applications/linkinbox.app" "$HOME/Applications/Atento.app"
cp -R "$APP" "$HOME/Applications/Atento.app"
