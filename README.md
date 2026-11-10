<p align="center">
  <img src="docs/assets/icon.png" width="96" height="96" alt="Atento icon" />
</p>

<h1 align="center">Atento</h1>

<p align="center"><b>A link inbox that triages itself.</b><br/>Stay up to date with what you read and only keep what gives value.</p>

<p align="center">
  <a href="https://github.com/espetro/atento/releases"><img src="https://img.shields.io/github/v/release/espetro/atento" alt="latest release" /></a>
  <a href="https://github.com/espetro/atento/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/espetro/atento/ci.yml?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license: Apache-2.0" /></a>
</p>

You save far more links than you read. Read-later apps turn into graveyards, and bookmark managers ask you to organize things you never opened.

Atento is the opposite: a small, local-first inbox where every link is extracted, summarized, categorized and given an expiry date. Fresh items surface, stale ones are proposed for the bin, and nothing is ever deleted without you saying so.

It is built to be driven by your agent. The whole workflow runs over [MCP](https://modelcontextprotocol.io), so Claude Code, Codex, Cursor or any MCP client can ingest, triage and sweep your links. A reference desktop app gives you the same inbox with a fast three-pane UI when you want to look at it yourself.

A lightweight, minimal alternative to mymind and Karakeep, with no account, no cloud and no server to run.

## Install

### MCP server and CLI (macOS and Linux)

```sh
# mise
mise use -g github:espetro/atento

# or the install script
curl -fsSL https://raw.githubusercontent.com/espetro/atento/main/install.sh | sh
```

You get two self-contained commands (Node is bundled, nothing else to install): `atento` (CLI and local web UI) and `atento-mcp`, a shortcut for `atento mcp` (the MCP server over stdio, always included with the CLI).

Add it to your agent:

```sh
# Claude Code
claude mcp add atento -- atento mcp

# Codex
codex mcp add atento -- atento mcp
```

Any other client, in its MCP config:

```json
{ "mcpServers": { "atento": { "command": "atento", "args": ["mcp"] } } }
```

Then ask your agent: "ingest my reading list, triage the inbox and tell me what needs a login".

### Desktop app

Download `Atento-desktop-<version>-<os>-<arch>` from the [latest release](https://github.com/espetro/atento/releases/latest) and open it. There is no setup dialog: the app starts its own local server, opens the inbox and shows its health in the footer status dot (green, orange or red, details in the dropdown).

macOS builds are not notarized yet, so the first launch needs `xattr -dr com.apple.quarantine /Applications/Atento.app`. On Windows, unzip `Atento-desktop-<version>-windows-x64.zip` and run `Atento-Setup.exe` (or `Atento\bin\launcher.exe`). Windows builds are experimental: they are built and smoke-tested in CI, not yet run by hand on a Windows machine.

## Quick start

```sh
atento import ~/Downloads/links.md     # markdown, json, url list, Safari Reading List and Bookmarks.plist
atento run                             # ingest + extract + enrich, idempotent
atento overview                        # what is in the inbox, by state and host
atento triage --batch --filter 'status:inbox category:job' --action archive
atento sweep                           # dry-run: what expired and why
atento serve                           # the web UI on http://127.0.0.1:4173
```

Enrichment needs any OpenAI-compatible endpoint (`OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `ATENTO_MODEL`). Importing and extraction work without one. No provider or model is hardcoded and no LLM runs outside `packages/enrich`.

## What it does

- **Ingest from anywhere.** Markdown, JSON, plain URL lists, Safari Reading List and Bookmarks, pasted text, remote gists, and a browser extension that captures the page from your own logged-in session. URLs are normalized and deduplicated, so re-importing is safe.
- **Extract the real content.** Readable markdown through defuddle and Readability, yt-dlp for video (with a tiered transcript stage), headless browser profiles for sites behind a login, and a page snapshot taken when you open a link.
- **Enrich once per link.** One structured-output call returns category, priority, a one-line "why it matters", read time and an expiry. Output is schema-validated and measured by a golden-set eval.
- **Expire, do not hoard.** Per-category TTLs. `sweep` proposes what went stale, `prune` hard-deletes only past your threshold and asks first, `restore` brings anything back.
- **Triage fast.** Read now, schedule, archive or discard, one link or a filtered batch, from the CLI, the MCP tools or the UI.
- **Built for agents.** 23 MCP tools with compact, token-shaped output, cursor-based deltas (`collections read enriched --since <cursor>`) and exit codes an automation can branch on.
- **Polite and resilient.** Per-host rate limits and circuit breakers, durable job state in SQLite, nothing re-fetched needlessly.
- **Local-first.** One SQLite file in `~/.atento`. Your data stays on your machine.

## Desktop app

The reference app is an [Electrobun](https://electrobun.dev) shell around the Svelte UI: inbox list, native preview panel with a persistent login per site, triage shortcuts, command palette, collections, and a floating assistant panel that talks to any [ACP](https://agentclientprotocol.com) agent you already have (Claude Code, Codex and others) so you can triage by asking.

## How it works

```
ingest → dedupe → extract → enrich → store → [ CLI | MCP | HTTP API | web UI ]
```

Every stage is a plain async function over a `Store` interface. There is no agent in the pipeline, only at its edges. The CLI, the MCP server and the HTTP API are thin wrappers over the same core operations.

| Path | What it owns |
| --- | --- |
| `packages/core` | Domain types, pipeline stages, state machine, limits and breakers |
| `packages/db` | SQLite store (drizzle, better-sqlite3), migrations |
| `packages/importers`, `packages/extractors`, `packages/media` | Ingest, content extraction, audio and video |
| `packages/enrich` | The only place a model is called |
| `packages/app` | Composition root shared by CLI, MCP and server |
| `packages/cli`, `packages/mcp`, `packages/server` | `atento`, `atento-mcp`, HTTP API |
| `packages/ui` | Svelte 5 + Tailwind web UI |
| `packages/extension` | Browser capture extension |
| `apps/desktop` | Electrobun desktop shell |
| `apps/harness` | Background service lifecycle and scheduler |

Design notes live in [`docs/`](docs): [capture](docs/capture.md), [state machine](docs/fsm.md), [resilience](docs/resilience.md), [stealth browsing](docs/stealth.md), [media](docs/media.md), [offline cache](docs/offline-cache.md).

## Develop

```sh
mise install            # node 24, pnpm 12, bun
mise run install
mise run validate       # build + typecheck (turbo-cached)
mise run test
mise run dev            # API + UI on http://localhost:4173
```

Release flow: add a changeset with `pnpm changeset`, merge to `main`, merge the "Version Packages" PR. CI tags the release, builds the CLI tarballs and desktop apps and publishes the GitHub Release, whose notes come from [`CHANGELOG.md`](CHANGELOG.md).

## Roadmap

- Windows: builds ship from 0.1.1 as experimental; the desktop shell needs a manual WebView2 check.
- Signed and notarized macOS app.
- npm packages for `npx atento-mcp`.

## License

[Apache-2.0](LICENSE). Copyright 2026 Joaquin Terrasa and contributors.
