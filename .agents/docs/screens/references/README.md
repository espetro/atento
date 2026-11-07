# Screen references: design research for linkinbox M4

UILOOP-style reference layer behind the screen specs in
`.agents/docs/screens/screen-*.txt`. Research material, not spec:
change the screen specs when behaviour changes; change these docs when
the product research changes.

## Index

- [`tokens.md`](tokens.md) — machine-readable type/spacing/color/motion
  values mapped onto linkinbox's decided semantic classes
  (`--color-surface/ink/accent` + `.btn`/`.chip`/`.pane`/`.list-row`/`.kbd`).
- [`patterns-three-pane.md`](patterns-three-pane.md) — sidebar + list +
  preview/detail grammar for triage surfaces.
- [`patterns-collection-sidebar.md`](patterns-collection-sidebar.md) —
  collections-with-counts + host grouping + saved filters.
- [`patterns-density-type.md`](patterns-density-type.md) — the user's
  stated taste (off-light-grey/off-white ground, mixed bold + light
  type) grounded in house siblings and captured products.

## Capture method

Screenshots live one level up in [`../refs/`](../refs/):

- `Screenshot 2026-11-06 at 18.12.07.png`, `…18.13.01.png` — the
  Readinglist macOS app running (sidebar smart lists + domain folders,
  middle list rows). User-captured during design research.
- `Screenshot 2026-11-06 at 18.19.06.png` — a third-party agent/chat
  app (Electron, multi-theme) showing the same sidebar | content |
  detail-pane grammar in a different product domain. User-captured;
  product unnamed in-repo.
- `readinglist-appstore.png` — Readinglist's App Store listing shot
  (same three-column layout, marketing crop).
- `mesurer-dev-landing{,-mid}.png`, `distill-id-landing{,-mid}.png` —
  captured 2026-11-06 via playwright-cli at 1440×900 for aesthetic/type
  reference only (both are marketing landings, not app UI).

No automated capture pipeline; competitor/app captures are manual.
Readinglist is a NATIVE app: we port its UX/layout grammar, never its
code (license bars redistribution — see its LICENSE).

## The `## Applies to` convention

Every `patterns-*.md` names the screen specs it governs. If a doc can't
name a screen, its content belongs in a note, not here.

## The patterns-not-targets rule

A pattern needs convergence across 2+ products to be stated as a rule;
one source is an anecdote and is labelled per-product divergence
instead. Where evidence is thin this is called out honestly rather than
smoothed over.
