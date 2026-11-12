#!/bin/sh
# Build the native atento binary.
# usage: build.sh <entry.ts> <out> [extra scriptc args]
#
# The FFI shim is built from the installed @cutils/sqlite package (which ships
# scripts/build-shim.mjs and the sqlite amalgamation) into SHIM_DIR, then
# handed to scriptc through --ffi. SHIM_DIR is reused when it already holds a
# manifest, so an incremental build does not recompile sqlite.
set -e
cd "$(dirname "$0")/.."
ENTRY=$1; OUT=$2; shift 2
SHIM=${SHIM_DIR:-$(pwd)/out/shim-$(uname -s)-$(uname -m)}
if [ ! -f "$SHIM/ffi.json" ]; then
  sh scripts/build-shim.sh "$SHIM"
fi
# flock keeps the heavy compile one-at-a-time on dev machines; it does not
# exist on every platform, so fall back to running directly.
if command -v flock >/dev/null 2>&1; then
  exec flock /tmp/tsc.lock pnpm exec scriptc build "$ENTRY" \
    --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
    --ffi "$SHIM/ffi.json" -o "$OUT" "$@"
fi
exec pnpm exec scriptc build "$ENTRY" \
  --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
  --ffi "$SHIM/ffi.json" -o "$OUT" "$@"
