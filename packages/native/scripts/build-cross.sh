#!/bin/sh
# Cross-build the native binary for another target.
# usage: build-cross.sh <target> <out>
#
# <target> is a scriptc target triple with a matching @scriptc/runtime pack
# installed (for example x86_64-linux-gnu, aarch64-linux-gnu,
# x86_64-windows-gnu, x86_64-apple-darwin). The runtime pack must be the
# exact scriptc version, and the C toolchain must be zig so the sqlite shim
# and the final link target the same platform.
set -e
cd "$(dirname "$0")/.."
# The scriptc toolchain payloads can come back non-executable from a restored
# package cache; the compiler then fails with SC3004.
node scripts/fix-toolchain-modes.mjs
TARGET=$1; OUT=$2
if [ -z "$TARGET" ] || [ -z "$OUT" ]; then
  echo "usage: build-cross.sh <target-triple> <out>" >&2
  exit 2
fi

# Map the triple onto the published runtime pack and the zig target.
case "$TARGET" in
  x86_64-linux-gnu) PACK=runtime-linux-x64-gnu; ZIG=x86_64-linux-gnu ;;
  aarch64-linux-gnu) PACK=runtime-linux-arm64-gnu; ZIG=aarch64-linux-gnu ;;
  x86_64-windows-gnu) PACK=runtime-win32-x64-msvc; ZIG=x86_64-windows-gnu ;;
  x86_64-apple-macosx14) PACK=runtime-darwin-x64; ZIG=x86_64-macos-none ;;
  *) echo "no runtime pack mapped for target $TARGET" >&2; exit 2 ;;
esac

RUNTIME=$(cd "node_modules/@scriptc/$PACK" 2>/dev/null && pwd -P) || {
  echo "missing @scriptc/$PACK: install it as a dev dependency of @atento/native" >&2
  exit 2
}

SHIM=${SHIM_DIR:-$(pwd)/out/shim-$TARGET}
if [ ! -f "$SHIM/ffi.json" ]; then
  CC="zig cc" AR="zig ar" node node_modules/@cutils/sqlite/scripts/build-shim.mjs \
    --out "$SHIM" --target "$ZIG"
fi

export SCRIPTC_TARGET="$TARGET" SCRIPTC_RUNTIME_PACK="$RUNTIME"
FLOCK=$(command -v flock 2>/dev/null || true)
if [ -n "$FLOCK" ] && [ -x "$FLOCK" ]; then
  exec "$FLOCK" /tmp/tsc.lock pnpm exec scriptc build src/cli.ts \
    --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
    --define "process.env.ATENTO_VERSION=\"${ATENTO_VERSION:-0.0.0}\"" \
    --no-keep-llvm \
    --ffi "$SHIM/ffi.json" -o "$OUT"
fi
exec pnpm exec scriptc build src/cli.ts \
  --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
  --define "process.env.ATENTO_VERSION=\"${ATENTO_VERSION:-0.0.0}\"" \
  --no-keep-llvm \
  --ffi "$SHIM/ffi.json" -o "$OUT"
