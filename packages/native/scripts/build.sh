#!/bin/sh
# usage: build.sh <entry.ts> <out> [extra scriptc args]
set -e
cd "$(dirname "$0")/.."
ENTRY=$1; OUT=$2; shift 2
SHIM=${SHIM_DIR:-/tmp/shim-darwin-arm64}
exec flock /tmp/tsc.lock pnpm exec scriptc build "$ENTRY" --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val,@chttp/router,@chttp/static --ffi "$SHIM/ffi.json" -o "$OUT" "$@"
