#!/bin/sh
# Local-only scriptc build; the CI `pnpm build` path skips it because the
# scriptc compiler needs toolchain setup the runners do not have.
# Run manually: sh scripts/build-nativeio.sh
set -e
cd "$(dirname "$0")/.."
[ "${SKIP_SCRIPTC:-}" = "1" ] && exit 0
exec pnpm exec scriptc build src/atento-io.ts -o dist/atento-io
