# Client-side capture ingest

`POST /capture` on the linkinbox server accepts content a client already extracted in the user's own logged-in session. Any client that can POST JSON can use it: a browser extension, a script on another machine, anything that speaks HTTP. The pipeline trusts that content more than anything it fetches itself, so a captured link skips the headless extract step entirely and goes straight to enrichment.

Only page captures are supported today. The schema carries a `contentType` field so future content types can be added without a breaking change; only `'page'` is accepted now.

## Contract

`POST /capture` with `Authorization: Bearer <token>` and a JSON body:

```json
{
  "url": "https://example.com/article",
  "title": "An article",
  "capturedAt": "2026-10-29T12:00:00.000Z",
  "contentType": "page",
  "body": "# An article\n\nMarkdown or plain text.",
  "selection": "optional quoted fragment",
  "meta": { "any": "client-specific key-value data" },
  "source": "stash"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `url` | yes | Normalized for dedupe (tracking params stripped, host lowercased). |
| `title` | no | Stored only when the link has no title yet. |
| `capturedAt` | yes | ISO 8601 with offset. Drives the freshness rule. |
| `contentType` | yes | Only `'page'` today. Discriminated-union ready. |
| `body` | yes | Markdown or text, the extracted content. |
| `selection` | no | Optional quoted fragment. |
| `meta` | no | Free-form client metadata, kept as-is. |
| `source` | yes | Client identity, e.g. `stash` or `stash@laptop`. Stored as the link's source. |

Responses: `201 {id, url, outcome: "created"}` for a new link, `200` with `outcome: "updated"` or `"duplicate"` otherwise. Errors: `401` bad token, `403` endpoint disabled (token unset), `400` invalid JSON or schema, `413` body over the size cap.

### curl

```sh
export LINKINBOX_CAPTURE_TOKEN=$(security find-generic-password -s linkinbox-capture -w 2>/dev/null || echo unset)

curl -s http://127.0.0.1:4173/capture \
  -H "authorization: Bearer $LINKINBOX_CAPTURE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/article",
    "title": "An article",
    "capturedAt": "2026-10-29T12:00:00.000Z",
    "contentType": "page",
    "body": "# An article\n\nBody text.",
    "source": "stash"
  }'
```

### Browser extension sketch

```js
// MV3 background service worker. Host permission for the target page plus
// the extension origin listed in [capture].allowed_origins.
const token = await chrome.storage.local.get('captureToken')

const res = await fetch('http://127.0.0.1:4173/capture', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token.captureToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    url: tab.url,
    title: await titleFromTab(tab),
    capturedAt: new Date().toISOString(),
    contentType: 'page',
    body: extractedMarkdown,
    source: 'stash',
  }),
})
```

## Auth and transport

The bearer token is never stored in config. `~/.linkinbox/config.toml` names the environment variable that holds it:

```toml
[capture]
token_env = "LINKINBOX_CAPTURE_TOKEN"
allowed_origins = ["chrome-extension://your-extension-id"]
max_body_bytes = 2097152
```

The token is read from that env var at request time and compared in constant time. When the variable is unset the endpoint refuses every request with `403`: capture is disabled, not open. The token is never logged.

The server listens on `127.0.0.1` by default. CORS is deny-by-default: only origins listed in `allowed_origins` (extension origins such as `chrome-extension://<id>` spelled out explicitly) receive CORS headers. Bodies over `max_body_bytes` are rejected with `413`.

## Dedupe, trust and the pipeline

Captures dedupe on the same normalized URL hash the importers use, so a captured link and an imported link are the same link.

An already-known URL is updated only when the capture is newer AND the stored content is empty or came from a lower-trust source. Trust order, highest first:

1. captured in the user's own logged-in session (`captured = true`)
2. headless extraction with a browser profile
3. anonymous headless extraction

A capture never downgrades newer or equal-trust content, and never resurrects a deleted link.

A new URL is stored with `source` set to the client's `source` and `captured = true`. Its state moves `created -> extracted` with the supplied body, so the extract stage (which claims `created` links) never picks it up: enrichment is the next step. The transition is recorded in the link history.

## Retrying headless

`linkinbox retry <id> --headless` re-queues a captured link for headless extraction. It is explicit and never automatic: the pipeline does not re-fetch captured content on its own. The link returns to the `created` state and the next extract run claims it; normal trust rules then decide whether anything is overwritten.

## Running behind a stable URL for mobile clients

Loopback only works for clients on the same machine. A mobile client needs a stable URL that reaches your desktop:

- Reverse proxy: put a TLS-terminating proxy (caddy, nginx) on a machine on your LAN or tailnet and proxy to `127.0.0.1:4173`.
- Tunnel: `cloudflared tunnel`, tailscale funnel or an equivalent gives you a stable public hostname mapped to the local server. Keep the bearer token on; the tunnel hostname is not a substitute for auth.

In both cases add the origin the mobile client presents (or none, if it is a native app using plain fetch) to `allowed_origins` as needed, and keep `token_env` set.

## iOS today

Safari on iOS cannot run this extension path today. The Reading List plist import (`linkinbox import <plist>`) remains the iOS route. An iOS Shortcut that POSTs to `/capture` is untested and is not claimed to work.

## Per-site cleaning of browser extractions

Headless reads of logged-in pages (`agent-browser read`) dump everything on the screen: navigation menus, keyboard-shortcut hints, the logged-in viewer's own name and headline, footers and language lists. That chrome pollutes the stored markdown and the enrichment prompt, so `cleanBrowserMarkdown` in `packages/extractors/src/clean.ts` strips it after the login-wall check in the browser extractor.

Cleaning dispatches on hostname:

- `x.com`: the leading keyboard-shortcut boilerplate and the right-hand sidebar (search filters, trending, who to follow, footer) are dropped; the timeline or conversation is kept.
- `www.linkedin.com`: everything before the `Feed post` heading (nav, search suggestions, the viewer's profile, Premium upsell) and the ad options plus footer after the post body are dropped; author, headline, age, post text and comments are kept.
- `www.instagram.com`: the left-nav words, the trailing footer with the language list and the duplicate caption echo are dropped; author, caption, hashtags and comment/like counts are kept.

Passthrough rule: cleaning is pure and never throws. Any other hostname is returned unchanged, and when a site's anchor is not found in the page the input is returned unchanged. It never returns empty output for non-empty input, and it never removes real content to hit a size target.
