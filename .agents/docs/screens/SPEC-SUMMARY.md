# M4 spec summary — screen specs, references, rubric

Docs-only deliverable for the M4 design gate. Everything below is a
PROPOSAL grounded in the current API/FSM surface; nothing here is
implemented. Gaps are collected in `screen-INDEX.txt` → "known gaps"
and repeated here.

## Screens

| screen | purpose | primary user task | riskiest UX assumption |
|---|---|---|---|
| `screen-triage-1` Triage workspace | daily loop: scan collection, preview, act | decide read_now/schedule/archive/discard per link | **R1**: four preview tabs (Reader/Metadata/Snapshot/Live) fit a ~420px pane without tab overload — Live especially may need to dominate or collapse |
| `screen-collections-1` Collections rail | navigation spine | pick collection/host/saved filter fast | **R2**: HOSTS group doubles as filter AND diagnostic (needs_login tint) — two jobs in one list may confuse; alternative is a dedicated attention row |
| `screen-needs-login-1` Attention view | "only you can fix this" | run `linkinbox login <host>` / re-extract / archive parked links | **R3**: remediation is CLI-shaped in a GUI — copy-command buttons may feel like a cop-out; a "login in browser" deep-link is spec'd as v2 but has no endpoint |
| `screen-ingest-1` Ingest dialog | add links | paste/upload → watch job summary → land in pending | **R4**: job-summary-only contract means the dialog can't show WHAT was ingested — users may expect a resulting list; mitigated by "view in pending" CTA |
| `screen-run-1` Run status | trust surface for automation | know if last run needs me; run again | **R5**: exit-code banner (0/2/1/3) is CLI vocabulary ported to GUI — needs the legend always visible or users won't learn it |
| `screen-settings-1` Settings | config + health + pairing | check adapters, pair extension, understand schedule | **R6**: most sections have NO read endpoint ([gap]) — risk of shipping a settings page of hints instead of data; GET /api/browsers is the highest-value gap to close first |

## Top-3 riskiest assumptions needing human review

1. **Live tab gating on `state_data.frameable`** — the field doesn't
   exist yet; until extractors record it, Live always degrades to
   snapshot + "Open in browser". Is iframe-ing-real-pages (sandboxed)
   even wanted, given login walls? The no-proxy rule is spec'd but the
   frameable rollout is undefined.
2. **`schedule` triage action has no date field** — TriageBody is
   `{ids, action}` only; `scheduledFor` exists in the FSM but no API
   carries it. The `s` key + date picker implies an API change
   (add `scheduledFor` to triage or a follow-up PATCH). Confirm before
   M4 UI builds the picker.
3. **Extension pairing is fully speculative** — "server URL +
   one-time token" has no endpoint, no code, and no defined exchange
   (code→token? code IS token?). Settings specs it as a proposed
   POST /api/pairing; needs a product decision before any UI.

## Reference coverage

- `references/` — UILOOP contract: README index, tokens.md,
  3 pattern docs (three-pane, collection-sidebar, density-type), each
  with `## Applies to` + ≥2 grounded sources.
- `refs/` — 8 screenshots: 3 user captures of Readinglist running,
  1 Readinglist App Store shot, 4 playwright-cli captures of
  mesurer.dev + distill.id landings.
- `rubric.txt` — M4 design-gate rubric (spec fidelity / API contract /
  design system / states / responsive+a11y / live data).

## M4b implementation status (post-gate)

Implemented on `feat/m4b`. Notable resolutions/deviations:

- Styling decision changed at implementation time: **daisyUI 5 retained as
  base + semantic classes**; Bits UI and Tailwind v4 dropped. Recorded in
  `screen-INDEX.txt` / `rubric.txt` / `references/tokens.md`.
- `GET /api/browsers`, `GET /api/pair/code`, `POST /api/pair` added as thin
  read/mint endpoints; settings ships read-only + pairing flow.
- `state_data.frameable` now recorded by the extractor; Live tab honest
  fallback retained.
- Schedule date picker NOT built: `TriageBody` has no `scheduledFor`; the
  `s` shortcut archives-to-schedule via the existing `schedule` action
  semantics only. Flagged for a follow-up API field.
- Saved filters are localStorage v1; no server persistence.

## Known gaps carried into M4 (not resolved by docs)

- ~~`GET /api/browsers`~~ — shipped in M4b
- ~~`POST /api/pairing`~~ — shipped as `GET /api/pair/code` + `POST /api/pair`;
  pairing-status read still absent (settings shows minted code only)
- `scheduledFor` on triage/schedule actions — still absent; date picker deferred
- config-read endpoint for settings sections
- `state_data.frameable` writer + artifact writer (snapshot.png)
- `scheduledFor` on triage action
- saved filters: localStorage-only in v1
- server-info/bind exposure for the Server settings card
