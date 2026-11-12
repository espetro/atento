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
# The scriptc toolchain payloads can come back non-executable from a restored
# package cache; the compiler then fails with SC3004.
node scripts/fix-toolchain-modes.mjs
ENTRY=$1; OUT=$2; shift 2
SHIM=${SHIM_DIR:-$(pwd)/out/shim-$(uname -s)-$(uname -m)}
if [ ! -f "$SHIM/ffi.json" ]; then
  sh scripts/build-shim.sh "$SHIM"
fi
# flock keeps the heavy compile one-at-a-time on dev machines; it does not
# exist on every platform, so fall back to running directly.
FLOCK=$(command -v flock 2>/dev/null || true)
if [ -n "$FLOCK" ] && [ -x "$FLOCK" ]; then
  exec "$FLOCK" /tmp/tsc.lock pnpm exec scriptc build "$ENTRY" \
    --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
    --define "process.env.ATENTO_VERSION=\"${ATENTO_VERSION:-0.0.0}\"" \
    --ffi "$SHIM/ffi.json" -o "$OUT" "$@"
fi
exec pnpm exec scriptc build "$ENTRY" \
  --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
  --define "process.env.ATENTO_VERSION=\"${ATENTO_VERSION:-0.0.0}\"" \
  --ffi "$SHIM/ffi.json" -o "$OUT" "$@"
