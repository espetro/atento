# @atento/extension

Browser extension capture for atento: save the page you are looking at, from your own logged-in session, straight to `POST /capture`. Design and decisions: `docs/extension.md` (milestones, safety rules, the Safari story). Wire contract: `docs/capture.md`.

This is the M1 proof of concept: an MV3 service worker that on action click captures the active tab, extracts a stub markdown in the page, builds the `/capture` payload and POSTs it with the bearer token, with an in-memory retry queue.

## Layout

| File | What it is |
| --- | --- |
| `src/manifest.json` | MV3 manifest: `activeTab`, `scripting`, `storage`. No host permissions. |
| `src/payload.ts` | Pure `/capture` payload builder (the wire shape from `docs/capture.md`). |
| `src/guard.ts` | Safety rules: private pages, banking-like hosts, the deny list, privileged URLs. |
| `src/queue.ts` | Bounded retry queue with full-jitter backoff and the pipeline's retry classifier. Injected clock, random and fetch. |
| `src/client.ts` | One POST to `/capture` with the bearer token. Injected fetch. |
| `src/extractor.ts` | The extractor seam plus the stub (`extractPage`). M2 bundles Readability or defuddle here. |
| `src/capture.ts` | The capture flow: tab in, refusal or payload out. All browser APIs injected. |
| `src/background.ts` | The chrome wiring for the service worker. |
| `src/content.ts` | The content script: extract the DOM, send it back, nothing else. |
| `src/messages.ts` | The content-to-worker message contract. |
| `src/options.html`, `src/options.ts` | Options page: token, server URL, source identity in `chrome.storage.local`. |

## Build and load

```sh
pnpm --filter @atento/extension build
```

Then in BrowserOS (or any Chromium): the extensions page, developer mode on, load unpacked from `packages/extension/dist`.

The token goes in the options page and lives in `chrome.storage.local`. The server must list the extension's origin in `[capture].allowed_origins` in `~/.atento/config.toml`, or the browser blocks the POST as a CORS error. The manifest pins a `key`, so the id is stable across reloads: `chrome-extension://dkongbmnamkaomnkljgognnbeamhfcci`.

## Tests

```sh
pnpm --filter @atento/extension test
```

40 unit tests over the payload builder, the queue and the safety/flow modules. The fetch, the clock and the random are injected fakes: nothing here opens a socket, and no test ever touches the network.
