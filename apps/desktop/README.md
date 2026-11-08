# @linkinbox/desktop

Electrobun desktop shell for linkinbox (Workstream B1 of
`.agents/plans/2026-11-07-ui-rework-design.md`).

The window loads the running linkinbox server — `linkinbox serve` on
`:4173` serves the built `packages/ui/dist` plus the API — and the UI
detects the shell to render real native preview webviews
(`<electrobun-webview>`, WKWebView on macOS) in the preview slot instead of
the reader/snapshot fallback.

## Running

```bash
# 1. serve the UI + API (from the repo root)
pnpm --filter @linkinbox/ui build
pnpm --filter @linkinbox/harness build
node apps/harness/dist/bin.js start   # binds :4173 by default

# 2. launch the shell
cd apps/desktop
export PATH="$HOME/.hutch/bin:$PATH"
hutch run install     # once — installs the Electrobun devkit + @types/bun
hutch run dev         # dev build, watches src/bun for changes
hutch run build       # stable build -> build/
```

Env vars (read by `src/bun/index.ts`):

- `LINKINBOX_URL` — page to load. Default `http://localhost:4173`.
  Point it at the vite dev server (`http://localhost:5173`) while
  iterating on `packages/ui`.
- `LINKINBOX_SELFTEST` — `partition-set` | `partition-check` | `dom-probe`:
  cookie persistence and DOM/pool probes (below). Leave unset for normal use.
- `LINKINBOX_SELFTEST_PORT` — collector port for the probe (default 4799).
- `LINKINBOX_PROBE_SELECT2` — with `dom-probe`, switches the selection to a
  second link id mid-run to verify the pool keeps one webview per host.

This package is a pnpm workspace member but is intentionally **not** part
of `pnpm -r build/test/typecheck` — it has no such scripts. Its deps are
managed by `hutch install` (bun-style `hutch.lock`), not pnpm scripts.
`.hutch/`, `build/`, `node_modules/` are gitignored.

## How the preview pool works

`packages/ui/src/lib/desktop.ts` + `src/components/NativePreview.svelte`:

- `isDesktopShell()` checks `customElements.get("electrobun-webview")` —
  Electrobun's preload registers the element on every hosted page. On plain
  web the check is false and PreviewPane renders the reader/snapshot
  fallback exactly as before.
- `showNativePreview(container, url)` keeps a `Map<host, element>` pool
  (LRU cap 8). Each `<electrobun-webview>` gets
  `sandbox` + `partition="persist:linkinbox-<host>"` **before** being
  appended (both are creation-only attributes).
- All pool entries stay mounted inside the preview slot's container,
  stacked; only the selected host's view is visible (`toggleHidden`).
  Selecting another link calls `loadURL()` on that host's existing view —
  no reload, scroll/JS state preserved. `PreviewPane` passes
  `placeholderData` to the detail query **on desktop only**, so the
  previous link's detail (and the mounted pool) survives the fetch gap;
  plain-web behavior is unchanged.
- `persist:` partitions are disk-backed per-host `WKWebsiteDataStore`s, so
  logins survive selections **and app restarts** (verified — see below).
  Evicting a pool entry destroys only the webview, never the cookies.
- The pool lives as long as the preview component is mounted; deselecting
  all links or leaving the preview view destroys it (cookies still persist).

## Verifying partition persistence (D0)

```bash
cd apps/desktop
LINKINBOX_SELFTEST=partition-set hutch run dev     # sets ckP/ckE/ckD, quits
LINKINBOX_SELFTEST=partition-check hutch run dev   # after restart: reads them
```

Expected: `persist:` and default partitions keep their cookies; the
ephemeral partition shows `(none)`. Full write-up:
`/tmp/linkinbox-desktop-partitions.md` (session artifact; key facts are
also in `src/bun/index.ts` comments and `packages/ui/src/lib/desktop.ts`).

`dom-probe` beacons the live `<electrobun-webview>` elements (count,
partition, sandbox, src, rect) to the collector; with
`LINKINBOX_PROBE_SELECT2=<id>` it also switches selection mid-run and
expects `dom-probe-count: 2` with one element per host.

## Known limitations

- **macOS-only verified.** Windows (WebView2) and Linux (GTK WebKit / CEF)
  use the same `persist:` convention but are untested — smoke-test early.
- `persist:` needs macOS 14+ for `WKWebsiteDataStore
  dataStoreForIdentifier:`; older macOS silently falls back to the shared
  default store (isolation degrades, nothing breaks).
- Each pooled webview is a real WKWebView (~50–150 MB per heavy page);
  the LRU cap of 8 bounds this.
- `<electrobun-webview>` initializes on the next `requestAnimationFrame`
  after being appended — fully occluded windows delay init until visible
  (harmless; navigation requested meanwhile is queued).
- Host `z-index` cannot paint over the native layer; popovers overlapping
  the preview may need the tag's `masks` attribute (not used yet).
- App icons live in `icon.iconset/` (macOS) and `icon.png` (Linux/Windows),
  declared in `electrobun.config.ts`. They were generated from the UI logo;
  replace them when a real brand icon exists.
- No bundled-API mode yet: the window always loads `LINKINBOX_URL`
  (dev-mode only). Bundling `packages/ui/dist` + the server into the app
  is future work.
- Killing the app ungracefully can lose recently-set cookies (normal
  WKWebView flush behavior).
