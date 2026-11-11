# atento on scriptc: status, gaps and CI plan

Branch `feat/scriptc-native`. Status: a native slice exists and works, the real CLI does not compile to a binary yet.

## What works now (packages/native)

`packages/native` is a scriptc program over `@cutils/cli`, `@cutils/sqlite` and `@chttp/mcp` that reads a real atento database.
Commands: `list`, `show`, `overview` (state counts and total only), `mcp` (stdio, four tools).
Measured on macOS arm64 against a copy of a real database (888 links):

- `list --json` and `list --json --limit 5` are byte identical to the Node CLI.
- `show <id> --json` is byte identical for ids 1, 12, 500 and 888. A missing id exits 1 with a different message.
- `overview --json` is a subset: `byState` and `total` match, `byParkReason` and `byHost` are not implemented.
- `mcp` answers initialize, tools/list and tools/call, but tool names use underscores and only four tools exist (the Node server has 23).
- Cold start for `list --limit 1`: about 0.00 to 0.05 s native, about 0.65 s for Node. Binary size: 4.5 MB (arm64), 4.9 MB (mac x64), 10.5 MB (linux x64), 10.7 MB (linux arm64).
- Linux, mac x64 and Windows binaries were only built, not run.

## What blocks the real CLI (`packages/cli/src/bin.ts`)

`scriptc coverage` reports 99 percent static for 8578 statements.
The remaining work is structural, not a list of compiler bugs:

1. Store. `@atento/db` is drizzle over better-sqlite3 (native addon). Node islands are report-only in scriptc 0.4.11, so neither can run in a build. Needed: a `SqlDriver` interface (prepare, run, get, all, exec, transaction, pragma) implemented by better-sqlite3 and by `@cutils/sqlite`, and `SqliteStore` rewritten from the drizzle builder to raw SQL with column mappers (snake to camel, timestamp_ms to Date, JSON columns, booleans). 68 methods, about 85 drizzle call sites. The existing db tests are the safety net. Migrations (`migrations.ts`) are already plain SQL strings.
2. MCP. `@atento/mcp` uses `@modelcontextprotocol/server` and zod/mini. A native entry needs a `@chttp/mcp` based server that adapts the `TOOLS` table (needs sigilco/chttp#107 for the stdio transport).
3. commander help (SC2001) and the optional `patchright` and extractor adapters (SC2013, SC2020). These are deferred-to-runtime fences: they throw if executed. Browser and extractors should be reached through an explicit sidecar process, not a library import.
4. `execFile` `timeout` option (SC2020), `process.stdin` data and end handlers (SC0001): scriptc compiler work, not started.

Done on this branch: LogTape replaced by a node:fs logger, optional modules (`mcp`, `server`, eval loader) registered in `packages/cli/src/modules.ts` instead of dynamic imports.

## Dependency PRs (all open, none merged)

- sigilco/cutils#53: FTS5 and a per-target shim script (macOS, Windows, cross).
- sigilco/chttp#107: `@chttp/mcp` stdio transport and the null id fix.
- sigilco/chttp#108: `rawJson` response helper in `@chttp/router`.

Until released, `packages/native` builds the shim with `CUTILS_BUILD_SHIM=<cutils checkout>/packages/sqlite/scripts/build-shim.mjs`.
`@chttp/mcp@0.4.1` has no stdio transport, so `src/mcpserver.ts` carries its own loop.

## Build recipe

```sh
export CUTILS_BUILD_SHIM=.../cutils/packages/sqlite/scripts/build-shim.mjs
sh packages/native/scripts/build-shim.sh /tmp/shim-<target> [zig-target]   # CC="zig cc" AR="zig ar" for cross
SCRIPTC_TARGET=<triple> SCRIPTC_RUNTIME_PACK=<dir of @scriptc/runtime-...> \
  pnpm exec scriptc build src/cli.ts --npm-static @cutils/sqlite,@cutils/cli,@chttp/mcp,@chttp/val \
  --ffi /tmp/shim-<target>/ffi.json -o out
```

Cross builds need runtime packs at the exact scriptc version (a 0.4.11 pack does not match a main-branch compiler) and zig 0.16 for the shim and link.
Windows uses `@scriptc/runtime-win32-x64-msvc` with triple `x86_64-windows-gnu`.

## CI plan (not implemented, release workflows untouched)

Reuse the matrix in `../calca` (`release-cli.yml`).
One job per target builds the shim with zig, then runs `scriptc build`, then smokes `list` and `mcp` against a fixture database seeded by the Node CLI.
Publish the native binary next to the Node tarball as `atento-native-<target>`.
Flip to the real CLI entry once the Store driver lands, and keep the Node CLI as the fallback until command parity tests (`packages/cli/test/cli-parity.test.ts`) run against both.
Release order: cutils#53, chttp#107 and #108, release them, then bump the versions here and drop `CUTILS_BUILD_SHIM`.

## scriptc 0.4.11 compat results (2026-11-10)

Setup: scriptc 0.4.11 released packages and runtime packs, chttp and cutils built from merged main via local `link:` overrides (not committed; unreleased), no `--libnode` needed (no island is reachable from `packages/native`).
`packages/native/src/atento.ts` ports the pure read layer of the real schema to raw SQL (projection, FTS5 query, park reasons, collections, overview, pipeline rows); `cli.ts` and `mcpserver.ts` use it.

- `scriptc coverage src/cli.ts`: 98% of 3929 statements static, no errors. Remaining diagnostics: SC1090 on `shim_*` (only without `--ffi`, resolved by the manifest), SC2020 `TextEncoder` in the unused `@chttp/mcp` http transport, 2 SC6001 in `@cutils/cli` (`mergeExtra` copies).
- Native vs Node CLI on a 40 link fixture: 32 of 32 comparisons identical (list with status/state/category/stale/FTS/limit/fields, json and table, show text and json including history, overview text and json, error paths).
- MCP over stdio: 23 of 23 tools registered and listed. Ported and parity-identical to Node: `links_list`, `links_get`, `links_overview`, `links_pipeline`, `collections_summary`, `links_triage`, `links_restore`, `links_sweep`, `metrics_get`, `limits_status`, `login_pending`, `collection_read` (json + tsv with cursor), `collection_export` (jsonl/md/tsv to `<tmpdir>/atento-exports`, matching Node MCP's exportsDir resolution), `ingest_text`, `ingest_urls`, `ingest_file` (markdown/json/url-list; `.plist` Safari import stays unported), `ingest_status` (17 tools). 6 tools still answer "not available in the native build yet": `ingest_run`, `ingest_remote`, `browse_read`, `browse_hosts`, `extract_run`, `enrich_run`. Parity harness: 44/49 identical; the 5 diffs are all MCP schema/validation-error wording (`tools/list` JSON schema shape and zod vs `@chttp/val` error text), not data or operation differences.
- The store is writable: `openStore` uses `SqlStore` over `CutilsDriver` (`@cutils/sqlite`, OPEN_CREATE like better-sqlite3) and runs the same migrations; triage/restore/sweep-apply and ingest jobs produce byte-identical DB state in parity. `lib.ts` keeps a second readonly `Database` handle for the list/show/overview read layer.
- Config: `src/config.ts` resolves the db path like `packages/app/src/config.ts` (ATENTO_DB, then `[db] path` in `~/.atento/config.toml` via `smol-toml` — already in the graph through core — then `<config-dir>/links.db`) and loads limits/login/pacing through the core `parse*Config` readers. `smol-toml` and `@types/node@^24` are declared deps of `@atento/native`; the @types pin matters — with @types/node 25 the `process.stdin` ReadStream typing makes scriptc reject the `readline.createInterface` lowering (SC2020 at runtime), with 24 it compiles and the stdio loop works.
- Ingest: `@atento/importers` cannot join the build (its package graph reaches `zod/mini`), so `src/importers.ts` vendors `parseMarkdown`, `parseUrlList`, `parseJsonLinks` and `readTextFile` verbatim. `ingest_job.ts` in core now builds commit chunks by index instead of `.slice` — the emitted JS stays inside the scriptc lowering subset (`array slice of 'unknown'` has no lowering in untyped dist JS). Everything else in `runIngestJob` (run journal, heartbeat, chunked `commitIngestChunk`, metrics) runs from core dist as checked-dynamic code.
- `login_pending`/`limits_status` read `~/.atento/config.toml` through `src/config.ts` (node:fs/os/path compile fine); `limits_status` intentionally uses `DEFAULT_GUARD_CONFIG` because Node's `ops.guardDeps()` does. Core's `login-hosts` sort uses relational string compare — scriptc has no `localeCompare` on dynamically-typed strings (same wall awaits `overview.ts`, `browse.ts`, `until-empty.ts` when those paths get ported).
- Cross builds from a macOS arm64 host with zig 0.16 shims and 0.4.11 runtime packs: linux-x64, linux-arm64, win-x64, mac-x64 all link (ELF, ELF, PE32+, Mach-O). Not run (no foreign hosts here).
- Known gaps: `links_get` accepts fields the Node schema rejects (no enum validation); `ingest_run` needs the multi-file `ops.ingestFiles` path, `ingest_remote` needs fetch, `browse_*` needs the browser read primitive, `extract_run`/`enrich_run` need network + LLM — all deferred until scriptc islands leave report-only or a sidecar exists. Local `link:` overrides in `pnpm-workspace.yaml`/`pnpm-lock.yaml` stay uncommitted until cutils/chttp release.
