# Pattern: density, ground, and type mix (the "off-white, bold+light" taste)

The user's stated taste for linkinbox: off-light-grey/off-white
ground, a mix of bold and light typefaces. This doc grounds that in
house siblings and captured products so M4 doesn't re-derive it per
screen.

## Applies to

- `references/tokens.md` consumers — every M4 screen
- `screen-triage-1`, `screen-run-1`, `screen-settings-1` (the densest
  surfaces where the taste matters most)

## Sources

1. **illo.fyi** `src/styles/global.css`: `--bg: #faf9f6` (warm
  off-white), `--fg: #1a1a1a`, `--muted: #8a8580`, `--accent:
  #ff6b6b`, Host Grotesk display + light body, 4px spacing, hairline
  `--border: rgba(0,0,0,0.08)`.
2. **cauce** `crates/cauce-server/web/src/spa/app/app.css`: Tailwind
  v4 `@theme inline` tokens over CSS vars, `--bg: #ffffff` +
  `--greyed-bg: #f4f4f5`, weight ceiling 600 for headings / 400 body,
  mono for meta/kbd, single `--shadow` floating-layer recipe.
3. **mesurer.dev** landing captures `../refs/mesurer-dev-landing{,-mid}.png`:
  dense tool UI marketing — tight type scale, restrained chroma,
  off-white ground.
4. **distill.id** landing captures `../refs/distill-id-landing{,-mid}.png`:
  "private think space" — light ground, generous whitespace, serif-adjacent
  display + light body contrast.
5. User's agent-app capture `../refs/Screenshot 2026-11-06 at 18.19.06.png`:
  six-theme engine, dense chat+artifact panes — evidence that themeable
  dense tools still keep one ground + one ink + restrained accents.

## Convergent rules

- **Ground is never pure white.** Every source sits in the
  `#faf9f6`–`#f4f4f5` band (warm paper or cool grey). Pure `#fff`
  reads clinical on a daily-driver tool; pure `#000` ink is avoided —
  `~#1a1a1a` is the house near-black.
- **One accent, used sparingly.** illo `#ff6b6b`, cauce `#2563eb`,
  mesurer/distill both near-monochrome with a single brand moment.
  linkinbox's `--color-accent` follows suit; STATE colors are a
  separate, semantic channel (`.chip-state-*`) and must not compete
  with the accent.
- **Bold for titles, light for density.** The mix is structural, not
  decorative: 600–700 weight carries screen titles and row titles;
  300–400 carries body/meta so dense lists stay readable. Two weights
  per region max (tokens.md type table).
- **Hairlines over shadows for static structure.** cauce's rule
  ("static surfaces stay hairline-bordered, never shadowed") ports
  directly: `.pane` separation = 1px ~10% ink border; shadow only on
  dialog/popover/tooltip.
- **Mono for machine strings.** cursors (`evt:{l,r,i}`), run ids,
  commands (`linkinbox login <host>`), token counts — cauce and the
  agent-app shot both set these in mono; linkinbox `.kbd` + meta mono
  matches.

## Divergences / honest gaps

- cauce ships light+dark themes; the user's taste statement only
  commits to the light ground. Dark theme is NOT spec'd — flag for
  human review (a `prefers-color-scheme` dark variant may be wanted
  later; tokens are structured to allow it).
- distill/mesurer are marketing captures — their app UI may differ;
  cited for ground/type/accent convergence only, not layout.
- No source fixes linkinbox's exact accent hue — that remains an open
  M4 decision (tokens.md marks it "user picks").
