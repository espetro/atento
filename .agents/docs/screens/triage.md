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
- Main content is a rounded card on the shell surface (Linear/brioso); sidebar has
  NO right border — the card carries the seam.
- Icon-only sticky topbar INSIDE the card: sidebar toggle left; search input +
  filter + settings right. No logotype (it lives in the sidebar header only).
- Sidebar: wordmark header, Search row (⌘K), chip row — Collections / By site /
  By type / Add — single scrollable line with overflow peek. Chips switch the
  listing group; Add creates custom collections.
- List pane: serif collection title + count + active-filter chips, Mail-style
  rows (avatar tile, title, host · meta line). No state dots, no label chips.
- Preview pane: resizable sibling, serif title, eyebrow sections.
- Agent: icon+title "Agent" dock bottom-right of the card → dialog with chat +
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
