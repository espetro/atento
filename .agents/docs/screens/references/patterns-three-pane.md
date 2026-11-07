# Pattern: three-pane triage layout (sidebar | list | preview)

The core grammar of linkinbox: a navigation column, a scannable item
list, and a detail/preview pane that updates with selection. This doc
grounds that choice in products that already ship it.

## Applies to

- `screen-triage-1` (whole layout)
- `screen-collections-1` (first pane)
- `screen-needs-login-1` (reuses the same shell)

## Sources

1. **Readinglist** (native macOS, SwiftUI) — `NavigationSplitView` with
   three columns: sidebar (smart lists + domain folders), content
   (paginated item list), detail (web preview). Code:
   `Sources/ReadingList/ContentView.swift` (`sidebarView` /
   `detailView` / `previewView`, column widths min 220/ideal 270,
   360/500, 360/520). Shots: `../refs/Screenshot 2026-11-06 at
   18.12.07.png`, `…18.13.01.png`, `../refs/readinglist-appstore.png`.
2. **Agent/chat app** (Electron, user-captured, unnamed) —
   `../refs/Screenshot 2026-11-06 at 18.19.06.png`: left rail
   (agents/skills/messaging/artifacts), center conversation list,
   right detail/artifact pane. Different domain, same three-region
   grammar — evidence the pattern is not Readinglist-specific.
3. Platform convention: Apple HIG `NavigationSplitView` three-column
   idiom (sidebar / content / detail) — Readinglist is a literal
   implementation of it; macOS users already parse this layout.

## Convergent rules

- **Selection drives the third pane.** In Readinglist, clicking a row
  swaps the preview instantly; nothing opens a modal. linkinbox spec:
  `?selected=` in the URL does the same — selection is linkable state,
  not ephemeral UI state.
- **The middle list is the work surface; the right pane is context.**
  Actions that decide the item's fate (triage keys) live in the list's
  orbit; the pane is for reading/verifying before deciding. Readinglist
  puts Mark-read/Open in the preview toolbar; linkinbox puts
  a/s/d/r/o in the preview action bar AND keeps them list-scoped via
  the selected row.
- **Column widths are min/ideal, not fixed.** Readinglist:
  220–270 / 360–500 / 360–520. linkinbox spec: rail ~240–280px, list
  flexible min ~380px, preview flexible min ~420px; below breakpoints
  panes collapse rather than squeeze.
- **The preview pane has its own header + body split.** Readinglist:
  title + icon buttons row, divider, then `WebPreviewView`. linkinbox:
  URL/title/state header, tab bar, then tab content — same anatomy.
- **Empty third pane is a teaching state, not blank.** Readinglist:
  icon + "Select a link to preview" + one-line instruction. linkinbox:
  same pattern (spec'd in triage-1 preview header area).

## Divergences (single-source, do not generalize)

- Readinglist's preview is a live `WKWebView`; linkinbox deliberately
  does NOT iframe arbitrary pages by default — Live tab is gated on
  `state_data.frameable`, otherwise snapshot + "Open in browser". This
  is a linkinbox-specific safety decision (no header-stripping proxy),
  not a pattern borrowed from Readinglist.
- Readinglist paginates at 250-item pages with `.onAppear` load-more;
  linkinbox uses explicit "load more" (50/page) because its data is
  server-paginated with a hard 200 cap on collection reads.

## Anti-patterns observed / rejected

- Card-grid link walls (Pinterest-style): rejected — triage is a
  sequential scan task, density beats browsing chrome.
- Modal detail views: rejected — Readinglist and the agent app both
  keep detail in-pane so list context (scroll position, selection)
  survives.
