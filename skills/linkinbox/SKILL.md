---
name: linkinbox
description: Triage web links through the linkinbox pipeline — ingest links, run the extract/enrich pass, then read token-efficient collections (enriched, pending, needs_login, blocked, errored, review, triaged) via the CLI, MCP tools or HTTP API. Use when a harness or agent needs to collect, dedupe, enrich and surface links for a user; when links are parked needing a login; or when the user asks to "run linkinbox" and report what needs attention. Read-only over the link store except through the documented ingest/triage commands.
---

# linkinbox (link triage pipeline)

linkinbox is a durable, CLI/MCP-first pipeline: links go in, get extracted and enriched, and land in named collections a harness reads cheaply. There is no recurrence inside the pipeline — the caller (you, a cron, launchd) decides when to run it.

## The harness contract

One pass, then read the deltas:

```sh
linkinbox run            # ingest [sources] + files, extract until empty, enrich until empty, sweep
linkinbox collections summary
linkinbox collections read enriched --since <cursor>
```

`run` prints `run <runId>: cursor <before> -> <after>` and per-stage `ok/input` lines. Exit codes:

- `0` — everything done.
- `2` — finished but some links need the user (needs_login / blocked / errored). Surface them.
- `3` — another run holds a stage lock (busy). Retry later; never treat as failure.
- `1` — failure (see stderr).

After a run, call `collections summary` (MCP `collections_summary`, `GET /api/collections/summary`). It returns counts per collection plus a per-host breakdown of `needs_login` — one line per host to log into. That breakdown is what you surface to the user.

Then read the delta: `collections read enriched --since <cursor>` where `<cursor>` is the `cursorAfter` from the run (or your stored cursor). The response carries the next cursor — store it and pass it next time. You only ever receive what changed.

## Ingest (never echoes payloads back)

| You have | Command / tool |
|---|---|
| A local file (md, json, txt, Safari plist, html bookmarks) | `linkinbox ingest file <path>` / `ingest_file` |
| Notes or chat dumps containing URLs | `linkinbox ingest text "..."` / `ingest_text` |
| A list of URLs (max 500/call) | `linkinbox ingest urls <url...>` / `ingest_urls` |
| A gist or raw file URL | `linkinbox ingest remote <url>` / `ingest_remote` |

Every ingest returns `{ jobId, accepted, duplicates, rejected, status }` — progress only, never the links. Poll `ingest_status { jobId }` for large jobs. URL-hash dedupe makes re-ingesting safe: duplicates are counted, not reprocessed. Configure recurring sources once in `~/.linkinbox/config.toml`:

```toml
[sources]
paths = ["~/links.md", "https://gist.example.com/raw/..."]
```

`run` ingests these automatically each pass.

## Collections

Exactly seven, all readable via `linkinbox collections read <name>`, MCP `collection_read`, or `GET /api/collections/:name`:

| Collection | Holds |
|---|---|
| `enriched` | `inbox` links with enrichment — the finished results |
| `pending` | `created`/`extracting`/`extracted`/`enriching` — still working |
| `needs_login` | parked on a login wall — needs the user |
| `blocked` | parked for other reasons (bot block, JS shell, timeout) |
| `errored` | extraction/enrichment failed |
| `review` | review-only hosts |
| `triaged` | `scheduled`, `archived`, `discarded` |

Read options: `--since <cursor>` (delta only; the HTTP route also accepts `cursor=`), `--fields id,url,title,category,priority,summary` (projection; `summary` is `why_it_matters` truncated to 200 chars), `--format tsv` (~40% fewer tokens than JSON), `--limit`/`--offset` (max 50/page by default). Every read returns the next cursor: JSON carries a `cursor` field, TSV ends with a `# cursor: <n>` trailer line, and HTTP adds an `x-linkinbox-cursor` header — store whichever you got and pass it back as `since`. For large sets use `collection_export` / `linkinbox collections export <name>` which writes `~/.linkinbox/exports/<name>-<cursor>.<ext>` and returns `{ path, uri, count, bytes }` — `uri` is a `linkinbox://exports/...` resource link to read lazily. The HTTP `format=jsonl|md` streams every matching row uncapped.

## Reading pages that need a login (linkinbox-browser, folded in)

Some links park in `needs_browser`/`needs_login` because a headless fetch hits a wall. A separate read-only surface lets agents read those pages through the user's own saved browser profile:

- **Allowlist.** Only hosts in `[share] hosts` in `~/.linkinbox/config.toml` may be read; the list ships EMPTY. A `not_shared` refusal is an owner action — ask, never route around.
- **Read-only.** No clicks, typing, forms or navigation API exists on this surface.
- **Paced and capped.** Same per-host budget as the pipeline: human pacing, daily cap, working-hours window, circuit breaker. On `reason: "deferred"` with `retryAfterMs`, wait and retry later.
- **Write-none.** Browse reads leave no trace in the link store.

Tools: MCP `browse_read { url }` and `browse_hosts`; CLI `linkinbox browse <url>` and `linkinbox browse hosts`. `browse_hosts` first when unsure. Refusals (`not_shared`, `no_profile`, `login_wall`) are owner actions: the owner runs `linkinbox login <host>` once in a terminal. Never ask for, log or store anything from the profile directory — cookies never leave the machine.

## Good agent behaviour

- Run, read the summary, read `enriched --since <cursor>`, surface `needs_login`. That is the whole loop.
- Store the cursor between runs; deltas keep responses small whether you run hourly or weekly.
- A `busy` (exit 3) means another run is working — wait, don't retry-storm.
- Prefer `ingest file` over pasting payloads: file ingest costs zero tokens for the content.
- `needs_login`/`blocked`/`errored` counts above zero after a run mean exit 2: report them, don't retry blindly.
