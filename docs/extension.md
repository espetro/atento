# Browser extension capture

This doc assesses how linkinbox can ingest links and page content from the user's own logged-in browser. It is a design plus a thin proof of concept, not a shipped extension. The proof of concept lives in `packages/extension`: an MV3 manifest, a service worker that captures the active tab and POSTs to `/capture`, a payload builder, and an in-memory retry queue, all unit tested with a fake fetch.

## The shape of the problem

The pipeline today has two ways to get content for a link. The headless path fetches the URL, routes it through defuddle, readability and finally the browser extractor, which logs in through a saved agent-browser profile under `~/.linkinbox/profiles/<host>`. The capture path lets any client POST content it extracted itself in the user's own session, and the pipeline trusts that content more than anything it fetches (`docs/capture.md`, trust order captured > headless profile > anonymous). The capture route already exists and works: `POST /capture` on the server, bearer token auth, CORS restricted to `allowed_origins`, a body size cap, dedupe on the normalized URL hash, and the captured link lands in `extracted` so the headless extract stage never picks it up.

The extension fills the gap the headless path structurally cannot: content behind a login that the pipeline does not have a profile for, and content the user already chose to look at. A capture from the extension is the highest trust tier there is, so it also means the extension can never be used to silently downgrade a link that the pipeline already extracted well.

The owner's rules constrain the design in three ways that everything below respects. Extension content is never auto-processed by the headless workflow: it lands as captured content, and headless re-extraction stays an explicit `linkinbox retry --headless`. The trust order is fixed: captured in the user session beats headless profile beats anonymous. Only page captures exist today, no notes, no stash groups. Mixed mode is wanted: headless with credentials and extension side by side, not either or.

## 1. Target platforms

MV3 for BrowserOS and Chromium is the target, because BrowserOS is a Chromium fork and MV3 works there unchanged. The permission model matters more than the engine: the extension needs `activeTab` plus `scripting` and nothing else for the one-click capture, which means no host permissions, no content script registered on every page, and no broad warning at install time. That is the only design that will pass a user's install-time review without friction, and it also means the extension has no ambient access to any site it is not explicitly acting on.

The Safari story has three options and they are not equivalent.

A Safari Web Extension is the same MV3 code in a different wrapper, but it needs a native Xcode wrapper app, an app group for shared storage, a Safari extension target, and a notarisation and App Store distribution path. The extension source is shared with Chromium, but the delivery mechanism is a full iOS app project, the Safari Web Extension APIs are a subset of Chromium's, and Safari's background page lifecycle is different from an MV3 service worker. The build tooling is Xcode, not pnpm, which breaks the workspace's build story and puts a second toolchain in the loop.

An iOS Share Sheet via Shortcuts POSTing to `/capture` is much cheaper: no app to build, no Xcode project, and the user picks a URL from any app's share sheet. It is also the weakest capture: Shortcuts can pass a URL and a title but cannot hand over the rendered DOM, so the body would be empty and the link would land with no content. That is a bookmark, not a capture. It also needs a reachable server, because the phone is not on loopback, so it needs the reverse proxy or tunnel described in `docs/capture.md`.

The Safari Reading List plist import is already in place (`packages/importers/src/safari-reading-list.ts`, `linkinbox import <plist>`) and needs nothing new. It carries URL, title, preview text and the date added, so it covers the "save for later" habit on iOS at the cost of page content, and it requires Full Disk Access on macOS.

Recommended order: MV3 for BrowserOS and Chromium first, because that is where the logged-in-session content actually comes from and it is a single pnpm package with no second toolchain. Then the iOS Shortcuts share sheet, because it is nearly free once the loopback problem is solved with a tunnel and it gives iOS users a one-tap "send to linkinbox" path even if the content is URL-only. The Safari Web Extension comes last, and only if macOS Safari users turn out to need logged-in capture badly enough to justify an Xcode wrapper app, a shared app group for the bearer token, and a distribution pipeline. The Reading List import stays as the macOS/iOS safety net in the meantime.

One caveat about the Shortcuts path: `docs/capture.md` currently says an iOS Shortcut that POSTs to `/capture` is untested and not claimed to work. That stays true until someone actually builds and runs one, and building it should be a milestone with a real test rather than a claim.

## 2. Capture modes

Mode (a) is a one-click "save this page" that reads the already-rendered DOM and extracts it client side, either with a bundled copy of defuddle or with Readability plus turndown. This is the highest value per unit of effort: it captures exactly the thing the headless path struggles with, a page the user is already logged into, and it reuses an extraction strategy that already exists in `packages/extractors`. The DOM is already rendered, so there is no wait, no login wall and no profile. It also gives the highest trust tier.

Mode (b) is "save all tabs" or "save a tab group". It is the same extraction as (a), just fanned out over a set of tabs, so it is cheap to add once (a) exists. The real work is the UX (a picker for which tabs, how many at once) and the rate of `chrome.scripting.executeScript` calls across many tabs.

Mode (c) is a bookmark folder or Reading List sync. This is not really a capture: it is a bulk import of URLs the user bookmarked but never read. The pipeline already has importers for exactly this shape (`packages/importers`), including the Safari Reading List plist, and those links go through the normal headless path where the pipeline can apply its rate limits and walled-garden pacing. Doing it from the extension would bypass the resilience machinery, which is the thing most worth protecting. The extension should not do (c).

Mode (d) is passive capture rules per host: automatically capture every page on `example.com` as you browse. This is the most dangerous mode and the most expensive. It turns the extension into a continuous harvester of the user's browsing, it conflicts with the trust model (a passively captured page is not what the user chose to save), it can capture private and banking pages by accident, and it puts the extension at odds with every site's terms of service. It also duplicates what the headless path already does for hosts the pipeline has a profile for.

Recommended order: (a) first, then (b), then (d) never or only in a heavily constrained form, and (c) never in the extension. The recommendation for (a) first is that it is the mode that adds a capability the pipeline genuinely lacks, it is the mode the owner described, and it is one service worker handler. Mode (b) follows because it reuses (a)'s extraction path exactly and adds only fan-out. Mode (d) is recommended against in this design because passive capture without an explicit per-page user action breaks the "captured in the user's session" trust story: the user did not choose that page. If it ever ships, it should be off by default, per host, and never capture on hosts that are sensitive by category.

## 3. What to send

The existing `/capture` schema is reused as-is. It already carries `url`, `title`, `capturedAt`, `contentType`, `body`, `selection`, `meta` and `source`, and it is already validated by `parseCapture` in `packages/core/src/capture.ts`. The proof of concept sends exactly that shape, with no new required fields.

Two additive fields are needed for the media stage to see reels, and they belong in the existing `meta` free-form object rather than in the schema, because `meta` is already `z.record(z.string(), z.unknown())` and adding keys to it is not a schema change at all.

The first is `meta.videoObject` or `meta.ogType` or `meta.twitterCard`, the exact keys `isVideoMeta` in `packages/core/src/media.ts` already looks for. This matters because the media stage runs inside the extract stage (`packages/core/src/pipeline/extract.ts`), and a captured link never goes through the extract stage: it is born in `extracted`. So captured video links currently never get their media tiers run at all. The extension can send the video signals it reads from the page head, and the additive change on the server side is to run the media stage for captured links, or to fold the video metadata into the link so the media stage can find it later.

The second is `meta.capturedBy`, a free-form client identity such as `extension` or `extension@browseros`. `source` already carries a client identity for the link itself, so this is redundant unless the pipeline wants to distinguish a browser capture from a script capture that also uses `source`. It is optional.

Two caveats that the design must state plainly, because they are the difference between a doc that matches the code and one that does not.

`selection` is accepted by the schema and validated, but `captureIngest` in `packages/core/src/capture-ingest.ts` does not persist it: only the body is written to `extracted_content`, and the title is written only when the link has no title yet. So a quoted fragment sent by the extension is currently dropped. If the extension wants to send a selection, the additive server change is to persist it, most naturally by appending it to the body as a quoted block, since the `links` table has no `selection` column and adding a column plus a migration is a bigger change than the owner asked for. The recommended route is the append: the extension composes `body` as the extracted markdown with the quoted fragment appended, and `selection` stays as a convenience field that the server may start honouring later.

`meta` is likewise accepted and validated but not persisted. There is no `meta` column on the `links` table. So the video signals would be dropped too, which means the media stage still would not see them. The additive server change here is to persist the capture `meta` somewhere the media stage can read: either as a JSON column on `links` (a migration) or by writing the video signals into the extracted content as a metadata block the media stage parses. Both are listed below as additive changes rather than made in this slice.

## 4. Auth and transport

The bearer token lives in `chrome.storage.local`. It never appears in the code, in the config file or in a log line. The extension reads it at request time from storage and puts it in the `authorization` header. `chrome.storage.local` is the right choice over `chrome.storage.sync` because sync is readable by any extension on the same account and the token is a bearer secret.

The server is reached at `http://127.0.0.1:4173/capture` by default, which is what the server already binds (`packages/server/src/index.ts` defaults to hostname `127.0.0.1`). The extension origin is `chrome-extension://<id>`, and that exact origin must be listed in `allowed_origins` in `~/.linkinbox/config.toml`, because the CORS middleware only echoes origins that are in that list and never wildcards. The extension id is stable for a loaded unpacked extension only if the `key` field is pinned in the manifest, so the manifest should carry a fixed `key` so the id does not change between reloads and the config does not have to be edited every time the extension is reloaded. This is a real operational detail: without a pinned key, every `chrome://extensions` reload that changes the unpacked path produces a new id and silently breaks CORS.

CORS is the first thing that breaks and the hardest to debug, because the preflight `OPTIONS` returns 204 with no CORS headers when the origin is not in the list, and the browser reports a generic CORS error with no hint about the config. The extension should therefore surface the exact origin string in its options page so the user can paste it into `allowed_origins`, and it should treat a fetch failure that never reaches the server as a likely CORS or server-down case, not as a capture failure.

The MV3 service worker lifecycle is the other structural constraint. The worker is killed after about 30 seconds of inactivity and it restarts on the next event, so in-memory state does not survive. That is exactly why the queue in the proof of concept is deliberately in-memory and explicitly documented as such: a real implementation must persist the queue in `chrome.storage.local` (a `pending` array of payloads with attempt counters) so a worker restart does not lose captures. The rule for the worker is: do all state mutation inside the event handler, and treat every handler as if it is the first one after a cold start.

A capture click on a slow page can also exceed the worker's idle window, so the POST must not be awaited inside a long-lived message listener. The pattern is: the content script extracts and returns the markdown, the worker persists the payload to storage first, and the POST happens afterwards from a persisted queue. Persist first, then send, means a worker death mid-request loses nothing.

When the server is down, the payload is queued and retried. The queue retries with exponential backoff and full jitter, matching the retry classifier already in `packages/core/src/resilience/retry.ts`, and it gives up after a bounded number of attempts with the payload kept for inspection rather than silently dropped. A 401 or a 403 is not retryable: a 403 means the capture endpoint is disabled because `LINKINBOX_CAPTURE_TOKEN` is unset, and retrying will not fix it, so the queue marks the payload as failed and tells the user. A 400 means the payload is invalid, which is also not retryable. Network errors, 408, 425 and 5xx are retryable. This is the same classification the pipeline uses, so the extension does not invent a second retry policy.

The proof of concept implements exactly this queue in memory: a bounded queue, exponential backoff with jitter, retryable classification, and a `now` and `random` injection so the tests never sleep and never touch the network.

## 5. Safety

Four rules, enforced in the extension before anything is sent.

Private windows are never captured. `chrome.windows` and `chrome.tabs` report `incognito` for tabs in a private window, and `chrome.extension.isAllowedIncognitoAccess()` says whether the extension may run there at all. The proof of concept checks both and refuses. A private window is the user's most sensitive context and the owner asked for it explicitly.

Banking-like hosts are never captured. The check is a category list, not a hardcoded fetch target: a small set of host patterns for banks, payment providers and password managers, matched with the same exact-host-or-`*.suffix`-wildcard semantics the pipeline's `skipHosts` uses in `packages/core/src/resilience/limiter.ts`. The extension keeps its own copy of the patterns because it cannot read the pipeline's config file, and it should be seeded from the same config in a future iteration. Note the difference in intent: `skip_hosts` in the pipeline means "never fetch this", while the extension's banking list means "never capture this", which is stronger in the sense that it also blocks a user-initiated click.

Hosts on the skip-list are never captured either. The user should be able to see the effective deny list in the options page, and the extension should never silently ignore it.

There is a visible per-host allow/deny toggle. The simplest honest version is a deny list plus a global on/off switch, both shown in the options page and both stored in `chrome.storage.local`. A full allow list is tempting but it turns the extension into something that silently does nothing on most of the web, and users disable extensions that do nothing. The recommended shape is: a global enable switch, a per-host deny list seeded with the banking patterns, and a visible note in the popup of the current tab's decision, so the toggle state is always visible at the moment of capture.

The extension never sends cookies. It never reads `document.cookie`, never touches `chrome.cookies`, never sends the `Cookie` header, and never asks for the `cookies` permission. Cookies stay in the browser. The extension sends only the URL, the title, the extracted body, and the optional metadata described above.

One more safety rule that is easy to miss: the extension must not capture pages from origins the user excluded by other means, and it should not capture `chrome://`, `edge://`, the extension's own pages, the browser's new tab page or any other privileged URL. A URL scheme and host check covers this.

## 6. Packaging and dev loop

`packages/extension` is a pnpm workspace package, so it lives alongside `packages/core`, `packages/extractors` and the rest and is built by `pnpm -r build`. It is a private package with no publishing step.

The build tool is esbuild, not vite. The extension has no bundler-needing framework: the service worker, the content script and the options page are plain TypeScript and plain HTML. esbuild bundles and minifies in one command, needs no dev server, and produces the exact file layout the manifest expects. The proof of concept uses esbuild 0.28 with a small build script. Vite would bring a dev server and a plugin ecosystem that this package does not need, and the ui package already uses vite if a future extension surface needs it.

The bundle for the client-side extractor is the awkward part. `defuddle` and `@mozilla/readability` are already dependencies of `packages/extractors`, but they run against a parsed document, and in an extension the DOM is already there. `@mozilla/readability` works directly on the live `document`, so it can be bundled and run in the page context. `defuddle` also accepts a document and can run client side. Bundling either into a content script is a real build step, so the proof of concept stubs the extractor behind an injected function and ships a naive DOM-to-markdown fallback. That is deliberate: the stub is the seam where the real extractor gets plugged in, and it keeps the first slice free of a 200 KB bundle.

The dev loop with BrowserOS is the standard Chromium one: build with `pnpm --filter @linkinbox/extension build`, open the extensions page, enable developer mode, and load the unpacked extension from `packages/extension/dist`. The manifest needs a pinned `key` so the extension id is stable across reloads, and the stable id is what goes into `allowed_origins` in the server config. The manifest must be written as `manifest.json` in the build output, either copied from `src/` or generated.

The offline test story is the same rule as everywhere else in this repo: no real network requests, ever. The proof of concept has three unit tested pieces and no integration test that touches a browser. The payload builder is a pure function from a tab snapshot to a `/capture` body, tested with fixture snapshots. The queue is tested with a fake fetch that returns scripted responses (network error, 500, 401, 201) and with an injected clock and random, so backoff is asserted without sleeping. The safety rules are tested as pure functions over URLs. Vitest runs in the node environment with no browser APIs, because the extension's own code is written to take its browser dependencies as injected parameters.

## 7. Risks and milestones

The risks, in rough order of how much they matter.

The trust rule is the one that can break the product. If the extension ever overwrites good headless content with worse extension content, the trust ordering is wrong and the pipeline becomes untrustworthy. The server already enforces this and the extension must not try to bypass it, so this risk is mostly about not weakening the existing rule when the additive changes land.

CORS and the stable extension id is the most likely operational failure and the least likely to be diagnosed quickly, because the failure looks like the server being down.

MV3 service worker death is the second most likely source of lost captures, and it is the reason the queue has to be persisted rather than held in memory.

Client-side extraction quality is the third. Readability and defuddle are good but they are tuned for pages the user did not ask to read, and on a short social post they may produce almost nothing. The pipeline's own rule is that low yield escalates to the browser extractor, and an extension capture has no escalation path, so the honest behaviour is to send a low yield capture anyway and let the trust and dedupe rules sort it out, or to refuse and let the user fall back to the headless path. The proof of concept sends it.

The Safari Web Extension route is a schedule risk, not a correctness risk: it needs an Xcode project, an app group, shared storage and a distribution pipeline, all outside the pnpm workspace.

Distribution and trust of an extension that reads page content is a product risk. The install-time permission prompt is what the user sees, so `activeTab` plus `scripting` and no host permissions is not just hygiene, it is the adoption strategy.

### Milestones

| Milestone | Scope | Effort |
| --- | --- | --- |
| M1 PoC skeleton | MV3 manifest, action click, active tab capture, stub extractor, `/capture` POST, in-memory retry queue, unit tests. This slice. | S |
| M2 Real client-side extractor | Bundle defuddle or Readability plus turndown into the content script, extract from the live DOM, per-host cleaning shared with `packages/extractors/src/clean.ts`. | M |
| M3 Persisted queue and options page | Queue in `chrome.storage.local`, options page with the token field, the server URL, the global switch, the deny list and the origin hint for `allowed_origins`. | M |
| M4 Save all tabs | Fan the M2 extraction out over a tab set or a tab group, with a picker. | M |
| M5 Media visibility for captured links | The additive server change: persist the capture `meta` and run the media stage for captured links so reels and videos get their tiers. | M |
| M6 Selection and notes | The additive server change: persist `selection`. Notes stay out of scope until the owner asks. | S |
| M7 iOS Shortcuts share sheet | A Shortcut that POSTs to `/capture` through a tunnel, tested on a real device. | S |
| M8 Safari Web Extension | Xcode wrapper app, app group, shared token, Safari-specific background page. Only if macOS Safari users need it. | L |
| M9 Passive capture rules | Per-host rules that capture as you browse. Off by default, never on sensitive hosts. Not recommended. | L |

The recommended order is M1, M2, M3, M4, then M5 and M6, then M7. M8 is last and conditional. M9 is not recommended.

### Additive server changes this design needs

None of these are in this slice. They are listed so the server work is scoped, and each one is additive in the sense that existing clients keep working unchanged.

The media stage for captured links. Today the media stage runs inside the extract stage, and a captured link is born in `extracted`, so it never runs. The change is to run the media stage for links whose capture metadata marks them as video. This needs the capture `meta` to be persisted first, which it currently is not.

Persisting the capture `meta`. The `links` table has no `meta` column. The change is a migration adding a JSON column, plus writing the capture meta in `captureIngest` and reading it in the media stage.

Persisting the capture `selection`. The `links` table has no `selection` column and `captureIngest` drops it. The cheapest route, which needs no migration, is to append the quoted fragment to the body at ingest time.

Neither of these touches the FSM. The captured link still moves `created` to `extracted` exactly as it does now, and the headless retry stays opt-in through `linkinbox retry --headless`.

## What the proof of concept is and is not

`packages/extension` is a skeleton, deliberately small. It has an MV3 manifest with `activeTab`, `scripting` and `storage` permissions, a service worker that on action click grabs the active tab, extracts a Readability-style markdown through an injected extractor function, builds the `/capture` payload and POSTs it with the bearer token, and a bounded in-memory retry queue with backoff. The extractor is stubbed so the real one can be dropped in later. The queue is in memory so the proof of concept does not pretend to survive a worker restart, which is the M3 job.

It does not read a real page, does not post to a real server, does not read a real token and does not ship. The tests are unit tests over pure functions and a fake fetch. Nothing in the package touches the network.
