# Tokens: machine-readable design values for linkinbox M4

Single source of truth for the values the screen specs and pattern
docs reference. Other docs link here instead of restating numbers.

## Applies to

All M4 screens: `screen-triage-1`, `screen-collections-1`,
`screen-needs-login-1`, `screen-ingest-1`, `screen-run-1`,
`screen-settings-1`.

## Stack (decided, do not relitigate)

Svelte 5 · daisyUI 5 (base layer) · semantic classes defined in
`packages/ui/src/app.css` over CSS custom-property tokens. **M4b decision:
Bits UI and Tailwind v4 were dropped; daisyUI is kept as the base.**
Allowed class vocabulary: `.btn`, `.chip`, `.chip-state-*`, `.pane`,
`.list-row`, `.rail-row`, `.kbd`, `.field`, dialog classes + the token
custom properties they resolve to. Raw palette utilities are forbidden on
surfaces — they break the token contract. Forms: @formisch/svelte +
valibot.

## Ground

User's stated taste: **off-light-grey / off-white background** —
never pure `#fff`/`#000`. House siblings agree:

| source | ground | ink | accent |
|---|---|---|---|
| illo.fyi `src/styles/global.css` | `--bg: #faf9f6` (warm paper) | `--fg: #1a1a1a`, `--muted: #8a8580` | `--accent: #ff6b6b` |
| cauce `app.css :root` | `--bg: #ffffff` light theme (greyed `#f4f4f5`) | `--fg: #1a1a1a`, `--muted: #666` | `--accent: #2563eb` |

linkinbox mapping (proposed `@theme` values — final hex is an M4
decision, relationships are the contract):

| token | role | guidance |
|---|---|---|
| `--color-surface` | app ground | off-white, slightly warm or cool grey; ~`#fafaf8`–`#f4f4f2` family |
| `--color-surface-raised` | panes, dialogs, popovers | one step lighter/warmer than surface; hairline border, no shadow on static surfaces |
| `--color-ink` | primary text | near-black `~#1a1a1a` family |
| `--color-ink-soft` | secondary/meta text | `~#6a6660`–`#8a8580` family |
| `--color-accent` | the ONE chroma | user picks; must hold contrast ≥4.5:1 on surface for text use |
| `--color-state-*` | pipeline states | needs_login=amber, blocked=red, errored=red-deep, review=violet, pending=grey-blue, enriched=green, triaged=neutral; used ONLY by `.chip-state-*` |

Depth: hairline borders (`1px`, ~8–14% ink alpha) separate regions;
shadows reserved for floating layers (dialog, popover, tooltip) — one
shared shadow recipe, matching cauce's `--shadow` convention.

## Type

User's stated taste: **mix of bold and light typefaces** — display/
headings bold, body light. Convergent with illo.fyi (Host Grotesk
display + light body) and cauce (semibold headings, weight ceiling
600, body 400).

| role | size | weight | notes |
|---|---|---|---|
| screen title | 22–28px | 700 (bold display) | collection name, view titles |
| section heading | 15–17px | 600 | card titles, banner heads |
| body / list summary | 14–15px | 300–400 (light) | why_it_matters, descriptions |
| row title | 14–15px | 500–600 | link titles in `.list-row` |
| meta / caption | 11–13px | 400 | hosts, dates, counts; may be mono for ids/cursors |
| kbd / code | 11–12px | 400 mono | `.kbd`, cursors, commands, run ids |

Rule: never more than two weights visible in one view region; bold is
for titles and the single accent moment, light carries density.

## Spacing / density

4px base unit (Tailwind default). Triage is a DENSE surface — Readinglist
rows run ~72–96px; target `.list-row` min-height ~64–80px with
`padding: 10–12px` vertical. Pane internal padding 16–20px; rail rows
32–36px tall.

## Radii

`.pane`/cards: 10–14px. `.chip`/`.btn`: pill or 6–8px — pick one shape
per family and hold it. `.list-row`: square (selection highlight is a
background wash, not a rounded card).

## Motion

Durations: hover/opacity 120–150ms; panel/tab transitions 180–220ms;
dialog enter 200ms. Easing: `cubic-bezier(0.19,1,0.22,1)` (illo.fyi
`--easing`) for enters; plain ease for color/opacity hovers. Everything
collapses under `prefers-reduced-motion`.

## Icons

Phosphor or Lucide, 16px in rows, 20px in headers; stroke weight regular.
State chips are color + text label (never color-only — a11y).
