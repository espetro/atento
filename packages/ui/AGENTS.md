# packages/ui

Svelte 5 (runes), Tailwind v4 + daisyUI, shadcn-svelte (bits-ui), TanStack query, paraglide i18n (`messages/en.json`, `m.*`), `~icons/lucide/*`.

## Design

- Two planes: level 0 = sidebar + dock row (`--color-sidebar`), level 1 = floating rounded card (`.app-main`). Screen specs: `.agents/docs/screens/`.
- Tokens live in `src/app.css`. One accent: light blue (`--color-accent-blue`, `--color-primary`). `--color-accent` is a neutral hover wash, pinned in `:root:root` because daisyUI's theme otherwise overrides it with teal. Never reintroduce another accent.
- Type: system sans + mono (`../pyscriptc` hierarchy), no serif.
- Topbar and sidebar header share one centre line (y=32); keep them aligned.

## shadcn sidebar quirks

- `data-slot` on menu buttons is overwritten; target `[data-sidebar='menu-button']`.
- `data-active:` matches `data-active="false"`; guard with `[data-active='true']`.
- Collapsed state: `[data-collapsible='icon']`; rows are centred 32px squares.
- Unlayered CSS beats Tailwind utilities; mind equal-specificity ordering.

## Rules

- Visual changes: verify in the web preview on the vite URL, then confirm in the dev desktop app (`apps/desktop/AGENTS.md`).
- Typecheck: `flock /tmp/tsc.lock pnpm --filter ./packages/ui exec svelte-check`.
- Search state is shared between the topbar search and the command palette (`query` bindable); do not fork it.
