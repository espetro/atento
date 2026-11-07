# Pattern: collection sidebar — counts, host grouping, saved filters

How the left rail organizes "what am I looking at": named collections
with live counts, a host dimension, and user-saved filter presets.

## Applies to

- `screen-collections-1` (the whole spec)
- `screen-triage-1` (rail consumption)
- `screen-needs-login-1` (attention collections surface here first)

## Sources

1. **Readinglist** — `ContentView.swift` `sidebarView`: "Smart Lists"
   section (All/Unread/Recently Added/Videos/PDFs, each with a count)
   + "Websites" section (domain folders with favicons + counts,
   `minimumDomainCount` threshold, context menu "Open All in Safari" /
   "Copy Links"). Shots: `../refs/Screenshot 2026-11-06 at
   18.12.07.png`, `…18.13.01.png`.
2. **distill.id** (note/vault app, marketing capture) —
   `../refs/distill-id-landing{,-mid}.png`: positions itself as "a
   space for thoughts… organize your vault" — the vault/collection
   sidebar is the category convention for this product class.
   Evidence is marketing-level only; treat its contribution as
   category confirmation, not layout detail.
3. linkinbox's own data model (`packages/core/src/collections.ts`):
   seven pipeline collections + `needsLoginHosts` per-host breakdown +
   `/api/pipeline` `byHost` histogram — the sidebar is a direct
   projection of existing API surface, not invented navigation.

## Convergent rules

- **Counts are always visible, right-aligned, secondary color.** Both
  Readinglist sections show `label … count`; linkinbox spec matches
  (`.list-row` + muted count). Counts are data (from
  `/api/collections/summary`), refreshed by SSE — never static labels.
- **Two grouping dimensions coexist: kind, then host.** Readinglist:
  Smart Lists (kind) then Websites (host). linkinbox: COLLECTIONS
  (pipeline position) then HOSTS (domain). Same two-axis grammar —
  "what state is it in" × "where did it come from".
- **Host rows earn their place by count threshold.** Readinglist hides
  domains under `minimumDomainCount`; linkinbox shows top-5 busiest +
  "show N more" — same anti-noise instinct, different mechanism
  (server already sorts byHost by total).
- **needs_login hosts are a first-class row, not a filter nuance.**
  Readinglist has no analogue (no auth concept) — this is linkinbox-
  specific, justified by the FSM: `login_wall` parks are actionable
  (`linkinbox login <host>`), so they get warning tint + the command
  in the attention view.
- **Saved filters are user-named presets over the same dimensions.**
  Readinglist persists smart-folder definitions; linkinbox persists
  {collection,q,state,category,host,stale} tuples in localStorage.
  Convergent: both treat "my recurring cut of the data" as a named,
  reusable object — but linkinbox v1 keeps them client-side (no sync).

## Divergences / honest gaps

- Readinglist's sidebar items are NavigationLinks with selection state;
  linkinbox collections are URL params — functionally identical,
  mechanically simpler (deep-linkable, back-button safe).
- No harvested product shows PIPELINE-STATE collections (pending /
  blocked / errored) in a sidebar — that taxonomy is linkinbox's own.
  The sidebar pattern is borrowed; the collection semantics are not.
- Saved-filter editing UX (rename/delete via context menu) is
  spec'd but has no direct screenshot evidence — flagged for human
  review in SPEC-SUMMARY.
