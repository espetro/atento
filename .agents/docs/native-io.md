# Native IO: enrich, extract, fetch, browser without --libnode

Branch `feat/native-io`, off `feat/scriptc-native-compat`. Verified with scriptc 0.4.11 on macOS arm64.

## Answer

No enrich, extract, media, fetch or browser path needs a Node island. The only separate process is browser capture, spawned as `atento-browserd` (JSON lines over stdin/stdout).

## Inventory

Classes: a already static, b first-party or builtin replacement, c chttp/cutils, d upstream work, e separate process.

| Dependency or site | Class | Decision | Evidence |
| --- | --- | --- | --- |
| ai, @ai-sdk/* (generateObject) | b | plain fetch chat completion with json_schema, `packages/enrich/src/chat.ts` | no longer in `scriptc coverage` of `bin.ts` |
| zod (enrichment validation) | b | hand validator on the native path, parity test against the zod schema | enrich tests |
| defuddle, @mozilla/readability, linkedom, turndown | b | first-party `packages/extractors/src/native/*` | 565 KB binary, corpus diff below |
| pdfjs | b | pdftotext, then mutool, then a built-in Flate and Tj/TJ decoder | 2 real PDFs, within 0.1% of pdftotext |
| fetch with redirects, timeout, size cap | a | `fetcher.ts`, AbortController and manual redirects | e2e |
| execFile timeout (scriptc#3529) | a | `spawnSync` with its own `timeout` | exec probe |
| patchright | e | `packages/browser/bin/atento-browserd.mjs`, spawned from `browserd.ts` | real Chrome escalation in e2e |
| native CDP over WebSocket | d | not needed now. @chttp/ws has no client | would need an upstream client |
| @chttp/html | c | renderer only, not a parser, so no help | read source |

## Measured

Corpus: 26 pages (22 live, fetched once each, plus 4 single-file snapshots). Metric: word-multiset F1 on prose, link and image targets removed from the native markdown first. Run `node packages/extractors/scripts/compare-corpus.mjs <native-bin> <corpus-dir> <urls.txt>`.

- native vs defuddle: mean F1 0.854, diff rate (F1 < 0.8) 23%. Without the link-target stripping: 0.761 and 38%.
- native vs readability: mean 0.719, diff rate 35%.
- readability vs defuddle baseline: mean 0.738, diff rate 31%.
- Native extraction takes 5 to 25 ms per page.
- Weak pages: a16z-style sites with heavy related-content blocks and the single-file snapshots, where native is over-inclusive.
- Binaries: extract-only 565 KB, full atento-io (fetch, extract, enrich, browserd client) 2.07 MB, linking only libSystem.

## End to end

`pnpm --filter @atento/nativeio build && node packages/nativeio/scripts/e2e.mjs` builds without `--libnode` and runs a fixture page server and an OpenAI-compatible mock. It checks extract, redirects, loop stop, 404, timeout, size cap, enrich, request shape, HTTP 500, missing env and browserd escalation of a 403 wall.

## Remaining islands in `packages/cli/src/bin.ts`

11578 statements, 99% static. Not on these paths: commander, hono, hono-openapi, better-sqlite3, drizzle-orm, @modelcontextprotocol/server, zod, smol-toml, xmldom, xmlbuilder, plist, quansync, @standard-community/*.

## Not verified

Linux and Windows, real LLM providers (use `ATENTO_RESPONSE_FORMAT=json_object` if strict schema is unsupported), and the Node `defaultFetch` in `packages/app` still uses its own fetch.
