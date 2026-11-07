# M4 spec summary — screen specs, references, rubric (REVISED)

Docs-only deliverable for the M4 design gate, revised per review.
Everything below is a PROPOSAL grounded in the current API/FSM surface;
nothing here is implemented. Gaps are collected in `screen-INDEX.txt` →
"known gaps" with milestone owners.

## Priority structure (revised — READ-FIRST)

The workflow is driven by an agent or deterministic tool; the UI is
primarily a READ surface plus a small set of deliberate write actions.

**CORE — the daily surface (read-mostly):**

| screen | purpose | primary user task | riskiest UX assumption |
|---|---|---|---|
| `screen-triage-1` Triage workspace | daily loop: scan collection, preview, act | decide read/schedule/archive/discard per link | **R1**: four preview tabs fit a ~420px pane without overload — Live especially may need to dominate or collapse |
| `screen-collections-1` Collections rail | navigation spine (chrome of core views) | pick collection/host/saved filter fast | **R2**: HOSTS group doubles as filter AND diagnostic (needs_login tint) — two jobs in one list may confuse |
| `screen-needs-login-1` Needs-login view | "only you can fix this" — makes the login process (which blocks ingestion) trackable | run `linkinbox login <host>` / re-extract / archive parked links | **R3**: remediation is CLI-shaped in a GUI — copy-command buttons may feel like a cop-out; a "login in browser" deep-link is v2 but has no endpoint |

**SECONDARY — chrome/dialogs (side-effect/write actions, not destinations):**

| surface | treatment | primary user task | riskiest UX assumption |
|---|---|---|---|
| `screen-ingest-1` Ingest dialog | dialog over any view (`?dialog=ingest`) | paste/upload → watch job summary → land in pending | **R4**: job-summary-only contract means the dialog can't show WHAT was ingested — mitigated by "view in pending" CTA |
| `screen-run-1` Run status | shell chip + popover + `?drawer=run` detail drawer — NO `?view=run` | know if last run needs me; run a pass | **R5**: exit-code banner (0/2/1/3) is CLI vocabulary — needs the legend always reachable (chip tooltip/drawer) or users won't learn it |
| `screen-settings-1` Settings | READ-ONLY `?view=settings` — config display + pairing, zero edit UI | check adapters/config, pair extension | **R6**: most sections have NO read endpoint ([gap], M4b) — risk of a settings page of hints; GET /api/browsers + config-read are the highest-value gaps |

## Decisions applied in this revision

1. **Read-first hierarchy** — triage/needs-login/collections are CORE;
   ingest/run/settings demoted to secondary chrome (INDEX rewritten).
2. **Settings is read-only** — no forms anywhere; config values +
   LINKINBOX_HOME-aware config path (`<configDir>/config.toml`,
   resolved server-side per packages/app/src/config.ts) + copy
   affordance. "Open config file" is infeasible over plain HTTP
   (file:// blocked) — path + copy only; a harness file-open
   affordance is future work.
3. **Run + ingest merged** — ingest stays `?dialog=ingest`; run status
   is now `components/RunChip.svelte` (top bar) + popover +
   `views/RunDrawer.svelte` (`?drawer=run`). No standalone run view.
4. **Data stack decided** — `@tanstack/svelte-query` v6 for ALL
   server state (already installed; `createQueryClient` pattern exists
   in src/lib/api.ts), `@tanstack/svelte-virtual` for the link list
   (already installed), `formisch` + `valibot` for form validation
   (ingest dialog + remaining forms; to be added in M4b).
5. **UI location decided** — `packages/ui` (`@linkinbox/ui`), the
   EXISTING Svelte package the harness serves; all paths updated from
   the earlier `apps/web` proposal.
6. **Scheduling is a harness feature** — recurrence lives in
   apps/harness `harness.toml` (`schedule` cron, `on_ingest`). NO
   `scheduledFor` API change, NO date picker. The `s` key fires the
   existing `{action:'schedule'}` triage call (scheduledFor stays null
   — the FSM accepts it but TriageBody doesn't carry it). Date/requeue
   UX is harness-UI future work, out of scope.

## Reconciled gaps

- **Pairing is REAL (M5, feat/m5 unmerged)** — `GET /api/pair/code`
  → `{code, expiresAt}` (8-char, single-use, 5-min TTL, bearer-gated
  on non-loopback) and `POST /api/pair {code}` → `{captureToken,
  serverToken}` (redeemed by the EXTENSION only — the UI never calls
  it). Spec updated to the actual contract
  (packages/server/src/pairing.ts, docs/capture.md); the speculative
  `POST /api/pairing` proposal is removed.
- **Still gaps, with owners:** `GET /api/browsers` (M4b), config-read
  for settings (M4b), pairing-status read (M4b/later),
  `state_data.frameable` writer + artifact/snapshot writer (extractor
  milestone, post-M4), saved filters server persistence (later).

## Remaining open questions (only these)

- **Q1 — Dialog/theme primitive library.** packages/ui ships daisyUI 5
  today (`@plugin 'daisyui'` in src/app.css); the earlier spec decided
  "Bits UI 2.20, no daisyUI" before the package existed and Bits UI is
  NOT installed. Specs now say "dialog primitive per Q1". Pick one
  before M4b: keep daisyUI, adopt Bits UI, or strip to semantic
  classes only. Rubric C4 grades against the decision.
- **Q2 — Existing views' disposition.** Inbox/Pipeline fold into
  Triage per spec; Sweep/Metrics/Dock exist today but are not in the
  new hierarchy. M4b decides whether they become secondary surfaces,
  fold into drawers, or are cut. (Not blocking — they're already
  built.)
- **Q3 — `j`/`k` wrap vs stop** at list ends (carried over; default
  wrap).
- **Q4 — 401/token UX**: on a token-required bind, does the UI prompt
  once and store the token (where?), or rely on same-origin harness
  serving? Affects run chip + every query's error path.

Resolved since last revision: scheduledFor API change (out of scope —
harness owns recurrence), pairing endpoint shape (real M5 contract),
UI location (packages/ui), data stack (tanstack + formisch/valibot),
screen hierarchy (read-first).

## Reference coverage

- `references/` — UILOOP contract: README index, tokens.md,
  3 pattern docs (three-pane, collection-sidebar, density-type), each
  with `## Applies to` + ≥2 grounded sources.
- `refs/` — 8 screenshots: 3 user captures of Readinglist running,
  1 Readinglist App Store shot, 4 playwright-cli captures of
  mesurer.dev + distill.id landings.
- `rubric.txt` — M4 design-gate rubric updated through implementation
  (svelte-virtual + formisch/valibot criteria; primitive layer decided:
  daisyUI 5 base + bespoke Dialog.svelte).

## M4b implementation status (post-gate)

Implemented on `feat/m4b`. Notable resolutions/deviations:

- Styling decision changed at implementation time: **daisyUI 5 retained as
  base + semantic classes**; Bits UI and Tailwind v4 dropped. Recorded in
  `screen-INDEX.txt` / `rubric.txt` / `references/tokens.md`.
- `GET /api/browsers`, `GET /api/runs`, `GET /api/config` added as thin
  read endpoints; `GET /api/pair/code` + `POST /api/pair` pre-existed and
  are now consumed by settings. `POST /api/links/restore` added in fix
  round 1 as the FSM-legal undo path.
- `state_data.frameable` is still NOT recorded by the extractor (only the
  mock fabricates it); Live tab keeps the honest snapshot fallback.
- Schedule date picker NOT built: `TriageBody` has no `scheduledFor`; the
  `s` shortcut archives-to-schedule via the existing `schedule` action
  semantics only. Scheduling is harness-owned; flagged for a follow-up
  API field if ever wanted.
- Saved filters are localStorage v1; no server persistence.

## Known gaps carried forward (post-M4b)

- ~~`GET /api/browsers`~~ — shipped in M4b
- ~~config-read endpoint~~ — shipped as `GET /api/config`
- ~~`POST /api/pairing`~~ — pre-existing as `GET /api/pair/code` +
  `POST /api/pair`; pairing-status read still absent (settings shows
  minted code only)
- `scheduledFor` on triage/schedule actions — still absent; date picker
  deferred (harness-owned scheduling)
- `state_data.frameable` writer + artifact writer (snapshot.png)
- saved filters: localStorage-only in v1
- server-info/bind exposure for the Server settings card
