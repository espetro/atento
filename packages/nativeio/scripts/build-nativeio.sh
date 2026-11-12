#!/bin/sh
# Local-only scriptc build; CI skips it because the scriptc compiler needs a
# toolchain the runners do not have (SC3004: TypeScript server startup).
# Run manually: sh scripts/build-nativeio.sh
set -e
cd "$(dirname "$0")/.."
if [ "${SKIP_SCRIPTC:-}" = "1" ] || [ "${CI:-}" = "true" ]; then
  echo "nativeio: skipping scriptc build (SKIP_SCRIPTC=${SKIP_SCRIPTC:-} CI=${CI:-})"
  exit 0
fi
exec pnpm exec scriptc build src/atento-io.ts -o dist/atento-io
