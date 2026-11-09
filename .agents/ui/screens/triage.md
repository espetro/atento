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
- NO app topbar in the content area. Sidebar carries its own collapse affordance.
- Sidebar groups: Search row (opens ⌘K palette) → **Collections** (icon + label + count)
  → **By site** (host + total, host avatar tile) → **By type** (category + count).
- List pane: serif collection title + count, filter button, pill search, Mail-style
  rows (avatar tile, title, host · meta line). No state dots, no label chips.
- Preview pane: resizable sibling, serif title, eyebrow sections.
- Agent: floating circular FAB bottom-right → floating chat panel (ACP). Docked pane
  removed. Hidden on plain web.
- Sidebar footer: empty (⌘K covers app actions).

## One-system rules
- One surface family (warm paper), one blue accent, hairline borders only.
- One font pair: sans UI + serif display (titles/empty states only).
- Labels Title Case everywhere.
- Motion budget: 120–240ms, ease-out-expo, transform+opacity only.
