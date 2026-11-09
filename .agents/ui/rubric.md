# UI rubric — linkinbox

## Hard gates (auto-FAIL)
- Console errors 0 / warnings 0 / network 5xx 0
- No layout collapse at 1440, 1024, 390 viewports
- `svelte-check` 0 errors, `vitest` green

## Consistency
- One surface family (warm paper tokens); no region on a different theme
- ONE accent (#2c4bd0); state color only on the state column/chips
- One font pair (sans body, serif `.display` titles); Title Case labels
- Hairline borders; shadows only on floating layers (menus, FAB, dialogs, toast)

## Motion
- Every interactive surface has a transition; instant changes are findings
- Popovers/dialogs: pop-in (scale .96→1 + fade, ≤200ms)
- List rows: staggered rise-in on first render, ≤18ms/row, ≤20 rows
- Hover = immediate (≤150ms); nothing animates > 300ms except layout

## Structure
- No app topbar; no sidebar footer buttons; no status dots or label chips in rows
- Collections listing groups: Collections / By site / By type
- In-app agent: FAB bottom-right → floating panel (desktop only)
- ⌘K + ⌘J keep working; ingest via `?dialog=ingest`
