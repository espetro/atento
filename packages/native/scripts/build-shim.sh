#!/bin/sh
# Build the @cutils/sqlite shim (FTS5 on) for one target and write a matching ffi manifest.
# usage: build-shim.sh <outdir> [clang --target triple]
# Uses scripts/build-shim.mjs from the installed @cutils/sqlite package, so a
# release build needs nothing but the published dependency.
set -e
OUT=${1:?outdir}
TARGET=${2:-}
PKG=$(cd "$(dirname "$0")/../node_modules/@cutils/sqlite" && pwd -P)
SCRIPT=${CUTILS_BUILD_SHIM:-$PKG/scripts/build-shim.mjs}
if [ -n "$TARGET" ]; then
  exec node "$SCRIPT" --out "$OUT" --target "$TARGET"
fi
exec node "$SCRIPT" --out "$OUT"
