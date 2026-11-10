# Screen: Triage shell

Refs: `ref-notion-sidebar` (flat icon+label groups, trailing count, hover affordances),
`ref-notion-floating` (floating "z" agent FAB bottom-right → expandable chat panel),
`ref-notion-share`/`ref-notion-animation` (snappy 150–200ms popover rise),
`ref-notion-people` (card view, quiet page chrome), Distill library + Quiet.md
(warm paper ground, icon+count sidebar), Mail-triage (avatar rows, two-line),
Apple Notes (serif centered empty states), elevenmusic.io (one accent, generous whitespace).

## Applies to
- `?view=triage` shell (sidebar + list + preview + agent FAB)

## Layout
- Two planes: level 0 = shell (sidebar + dock row beneath the card, same tone, no
  sidebar border); level 1 = floating rounded content card.
- Type: pyscriptc hierarchy — system sans for titles/narrative, system mono for
  counts, metadata, eyebrows, kbd. No serif.
- Resizable separators: line invisible, only the faint grip nudge remains.
- Icon-only sticky topbar INSIDE the card: sidebar toggle left; minimal icon+"Search" input (grows on focus) +
  filter + settings right. No logotype (it lives in the sidebar header only).
- Sidebar: wordmark header, Search row (⌘K), chip row — Collections / By site /
  By type / Add — single scrollable line with overflow peek. Chips switch the
  listing group; Add creates custom collections.
- List pane: serif collection title + count + active-filter chips, Mail-style
  rows (avatar tile, title, host · meta line). No state dots, no label chips.
- Preview pane: resizable sibling, serif title, eyebrow sections.
- Agent: minimal icon+title "Agent" button in the dock row (level 0) under the card → dialog with chat +
  quick-action chips above the composer. Desktop only (ACP bridge). Hidden on
  plain web.
- Sidebar footer: empty (⌘K covers app actions).
- Settings: two-pane Linear-prefs layout — left section nav, right cards,
  including an Agent section listing detected ACP clients + custom command.

## One-system rules
- One surface family (warm paper), one blue accent, hairline borders only.
- One font pair: sans UI + serif display (titles/empty states only).
- Labels Title Case everywhere.
- Motion budget: 120–240ms, ease-out-expo, transform+opacity only.
