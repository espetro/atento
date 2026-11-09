<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { createVirtualizer } from '@tanstack/svelte-virtual'
  import { get } from 'svelte/store'
  import { api } from '../lib/api'
  import { onShortcut } from '../lib/keyboard'
  import { hostOf, renderTitle, timeAgo, truncate } from '../lib/format'
  import { collectionMeta, reasonLabel } from '../lib/copy'
  import type { UrlState } from '../lib/urlState'
  import type { LinkAction, LinkSummary } from '../lib/types'
  import { hasShellBridge, linkMenuItems, showShellContextMenu } from '../lib/desktop'
  import { density } from '../lib/prefs'
  import IconChip from '../components/IconChip.svelte'
  import FilterMenu from '../components/FilterMenu.svelte'
  import IconListFilter from '~icons/lucide/list-filter'
  import IconCircleQuestionMark from '~icons/lucide/circle-question-mark'
  import IconSparkles from '~icons/lucide/sparkles'
  import IconCode from '~icons/lucide/code'
  import IconPalette from '~icons/lucide/palette'
  import IconPackage from '~icons/lucide/package'
  import IconShield from '~icons/lucide/shield'
  import IconWrench from '~icons/lucide/wrench'
  import IconBookOpen from '~icons/lucide/book-open'
  import IconTag from '~icons/lucide/tag'
  import IconFlame from '~icons/lucide/flame'
  import IconClock from '~icons/lucide/clock'
  import { m } from '../paraglide/messages.js'
  import type { Component } from 'svelte'

  let {
    url,
    setUrl,
    collection,
    onTriage,
    onReextract,
    onOpenUrl,
  }: {
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    /** Effective collection name (already resolved). */
    collection: string
    onTriage: (ids: number[], action: LinkAction) => Promise<void>
    onReextract: (id: number) => void
    onOpenUrl: (url: string) => void
  } = $props()

  const PAGE = 50
  let limit = $state(PAGE)

  // Reset paging when the filter set changes.
  $effect(() => {
    void [url.q, url.state, url.category, url.host, url.stale, collection]
    limit = PAGE
  })

  const query = createQuery(() => ({
    queryKey: ['links', collection, url.q, url.state, url.category, url.host, url.stale, limit],
    queryFn: () =>
      api.links({
        collection,
        q: url.q || undefined,
        state: url.state || undefined,
        category: url.category || undefined,
        host: url.host || undefined,
        stale: url.stale || undefined,
        limit,
        offset: 0,
      }),
  }))

  const items = $derived<LinkSummary[]>(query.data?.items ?? [])
  const total = $derived(query.data?.total ?? 0)

  // The cursor IS the URL selection: j/k and clicks write ?selected=.
  const cursorId = $derived(url.selected ?? items[0]?.id ?? null)
  const cursorIndex = $derived(items.findIndex((l) => l.id === cursorId))

  // Multi-select for batch triage (cmd-click toggle, shift-click range).
  let checked = $state<Set<number>>(new Set())
  let lastClickedIndex = $state<number | null>(null)

  const actionIds = $derived.by((): number[] => {
    if (checked.size > 0) return [...checked]
    return cursorId != null ? [cursorId] : []
  })

  function moveCursor(delta: number) {
    if (items.length === 0) return
    const i = cursorIndex === -1 ? 0 : cursorIndex
    const next = (i + delta + items.length) % items.length
    const id = items[next]!.id
    setUrl({ selected: id })
    // Keep the cursor row visible.
    get(virtualizerStore).scrollToIndex(next, { align: 'auto' })
  }

  function onRowClick(link: LinkSummary, e: MouseEvent) {
    const index = items.findIndex((l) => l.id === link.id)
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(checked)
      if (next.has(link.id)) next.delete(link.id)
      else next.add(link.id)
      checked = next
      return
    }
    if (e.shiftKey && lastClickedIndex != null) {
      const [a, b] = [lastClickedIndex, index].sort((x, y) => x - y)
      const next = new Set(checked)
      for (let i = a; i <= b; i++) next.add(items[i]!.id)
      checked = next
      setUrl({ selected: link.id })
      return
    }
    checked = new Set()
    lastClickedIndex = index
    setUrl({ selected: link.id })
  }

  // Keyboard contract (inert inside inputs/dialogs — the dispatcher checks).
  $effect(() => {
    const offs = [
      onShortcut('j', () => moveCursor(1)),
      onShortcut('k', () => moveCursor(-1)),
      onShortcut('ArrowDown', () => moveCursor(1)),
      onShortcut('ArrowUp', () => moveCursor(-1)),
    ]
    return () => offs.forEach((off) => off())
  })

  async function act(action: LinkAction) {
    const ids = actionIds
    if (ids.length === 0) return
    await onTriage(ids, action)
  }

  $effect(() => {
    const offs = [
      onShortcut('a', () => void act('archive')),
      onShortcut('s', () => void act('schedule')),
      onShortcut('d', () => void act('discard')),
      onShortcut('r', () => {
        if (cursorId != null) onReextract(cursorId)
      }),
      onShortcut('o', () => {
        const link = items.find((l) => l.id === cursorId)
        if (link) onOpenUrl(link.url)
      }),
    ]
    return () => offs.forEach((off) => off())
  })

  // ---- virtualization -----------------------------------------------------
  // createVirtualizer returns a Svelte store: it re-emits the instance on
  // every range change, so reading $virtualizerStore in the template always
  // yields fresh virtual items. count is pushed via setOptions below.

  let scrollEl = $state<HTMLElement | null>(null)
  let searchEl = $state<HTMLInputElement | null>(null)

  const virtualizerStore = createVirtualizer({
    count: 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => ($density === 'compact' ? 58 : 76),
    overscan: 8,
  })

  // Rows vary (why line optional, wrapped text) — measure each one so the
  // absolute offsets always match real heights. Fixed estimates drift and
  // make rows overlap after a few dozen entries. The virtualizer keys the
  // measurement off the wrapper's data-index attribute.
  function measureRow(node: HTMLElement) {
    get(virtualizerStore).measureElement(node)
    return {
      update() {
        get(virtualizerStore).measureElement(node)
      },
      destroy() {
        get(virtualizerStore).measureElement(null)
      },
    }
  }

  $effect(() => {
    // Re-subscribe options when density flips so row-height estimates track.
    const d = $density
    get(virtualizerStore).setOptions({
      count: items.length,
      estimateSize: () => (d === 'compact' ? 58 : 76),
    })
  })

  // Debounced search input -> ?q=
  let qInput = $state('')
  let qTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    qInput = url.q
  })
  function onSearchInput() {
    clearTimeout(qTimer)
    qTimer = setTimeout(() => {
      if (qInput !== url.q) setUrl({ q: qInput, selected: null })
    }, 250)
  }
  $effect(() => {
    const off = onShortcut('/', () => {
      searchEl?.focus()
      searchEl?.select()
    })
    return off
  })

  // ---- infinite scroll sentinel (A3) ----------------------------------------
  // Replaces the "load more" button: when the sentinel nears the viewport,
  // grow `limit` by one page. The effect re-fires after each fetch settles,
  // so pages chain automatically until the sentinel leaves view or the
  // collection is exhausted.
  let sentinelEl = $state<HTMLElement | null>(null)
  let sentinelHit = $state(false)

  $effect(() => {
    const el = sentinelEl
    if (!el || typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(
      (entries) => {
        sentinelHit = entries.some((e) => e.isIntersecting)
      },
      { root: scrollEl, rootMargin: '240px 0px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  })

  $effect(() => {
    if (sentinelHit && items.length < total && !query.isFetching) {
      limit += PAGE
    }
  })

  const ATTENTION = new Set(['needs_login', 'blocked', 'errored', 'review'])

  // Category → lucide icon (A3): type chips are icon-only with title/aria.
  const CATEGORY_ICONS: Record<string, Component> = {
    ai: IconSparkles,
    engineering: IconCode,
    design: IconPalette,
    product: IconPackage,
    security: IconShield,
    ops: IconWrench,
    reading: IconBookOpen,
  }
  function categoryIcon(cat: string): Component {
    return CATEGORY_ICONS[cat] ?? IconTag
  }
  const meta = $derived(collectionMeta(collection))
  const hasActiveFilters = $derived(
    url.q !== '' || url.state !== '' || url.category !== '' || url.host !== '' || url.stale,
  )

  function clearFilters() {
    setUrl({ q: '', state: '', category: '', host: '', stale: false, selected: null })
    qInput = ''
  }

  // ---- filter dropdown (A4) --------------------------------------------------
  let filterOpen = $state(false)
  let filterAnchor = $state<HTMLElement | null>(null)

  $effect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      if (filterAnchor && !filterAnchor.contains(e.target as Node)) filterOpen = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        filterOpen = false
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  })

  function isStale(link: LinkSummary): boolean {
    return link.expires_at != null && new Date(link.expires_at).getTime() < Date.now()
  }

  function onRowContextMenu(link: LinkSummary, e: MouseEvent) {
    if (!hasShellBridge()) return
    e.preventDefault()
    setUrl({ selected: link.id })
    void showShellContextMenu(linkMenuItems(link))
  }

  // Headline priority: the enrichment summary reads best, then a real
  // extracted title, then a title rendered from the URL slug. The raw URL
  // itself only surfaces as the metadata line, never as the headline.
  function displayTitle(link: LinkSummary): string {
    const why = link.why_it_matters.trim()
    if (why !== '') return why
    const t = link.title.trim()
    if (t !== '') return t
    return renderTitle(link.url)
  }
</script>

<div class="listpane" class:density-compact={$density === 'compact'} data-testid="link-list-pane">
  <header class="list-head">
    <div class="list-title-row">
      <h1 class="list-title">{meta.label}</h1>
      <span class="meta" data-testid="total-count">{m.list_total_items({ count: total })}</span>
    </div>
    <div class="search-row">
      <div class="search-side">
        <button
          type="button"
          class="btn btn-sm filter-btn"
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          onclick={() => (filterOpen = !filterOpen)}
          data-testid="filter-button"
        >
          <IconListFilter width={13} height={13} aria-hidden="true" />
          {m.filter_button()}
          {#if hasActiveFilters}<span class="filter-dot" aria-hidden="true"></span>{/if}
        </button>
        <div class="filter-anchor" bind:this={filterAnchor}>
          {#if filterOpen}
            <FilterMenu {url} {setUrl} />
          {/if}
        </div>
      </div>
      <div class="search-center">
        <input
          bind:this={searchEl}
          class="input search-input"
          type="search"
          placeholder={m.search_placeholder()}
          aria-label={m.search_aria()}
          data-testid="search-input"
          bind:value={qInput}
          oninput={onSearchInput}
        />
      </div>
      <div class="search-side search-side-end"></div>
    </div>
    {#if hasActiveFilters}
      <div class="filter-chips">
        {#if url.q}<button class="chip chip-button" onclick={() => { qInput = ''; setUrl({ q: '', selected: null }) }}>“{truncate(url.q, 30)}” ✕</button>{/if}
        {#if url.state}<button class="chip chip-button" onclick={() => setUrl({ state: '', selected: null })}>{m.chip_state({ value: url.state.replace(/_/g, ' ') })} ✕</button>{/if}
        {#if url.category}<button class="chip chip-button" onclick={() => setUrl({ category: '', selected: null })}>{m.chip_category({ value: url.category })} ✕</button>{/if}
        {#if url.host}<button class="chip chip-button" onclick={() => setUrl({ host: '', selected: null })}>{m.chip_host({ value: url.host })} ✕</button>{/if}
        {#if url.stale}<button class="chip chip-button" onclick={() => setUrl({ stale: false, selected: null })}>{m.chip_stale()} ✕</button>{/if}
        <button class="chip chip-button" onclick={clearFilters}>{m.chips_clear_all()}</button>
      </div>
    {/if}
  </header>

  {#if query.isPending}
    <div class="list-body">
      {#each Array(8) as _, i (i)}
        <div class="skeleton" style="height: 88px; margin: 6px 10px;"></div>
      {/each}
    </div>
  {:else if query.isError}
    <div class="list-body">
      <div class="notice notice-bad" role="alert">
        {m.list_load_error()}
        <button class="btn btn-sm" onclick={() => void query.refetch()}>{m.action_retry()}</button>
      </div>
    </div>
  {:else if items.length === 0}
    <div class="list-body empty">
      <div class="empty-card pane">
        <p class="empty-title">{m.list_empty_title({ collection: meta.label })}</p>
        <p class="meta">
          {#if collection === 'pending'}
            {m.list_empty_pending()}
          {:else if ATTENTION.has(collection)}
            {m.list_empty_attention()}
          {:else}
            {m.list_empty_default()}
          {/if}
        </p>
      </div>
    </div>
  {:else}
    <div class="list-body scroll-thin" bind:this={scrollEl} data-testid="link-list">
      {#if items.length > 12}
        <div class="relative w-full" style={`height: ${$virtualizerStore.getTotalSize()}px;`}>
          {#each $virtualizerStore.getVirtualItems() as row (row.key)}
            {@const link = items[row.index]}
            <!-- The virtual count can lag a shrinking list by a frame; skip
                 rows whose index fell off the end instead of crashing. -->
            {#if link}
            <div
              class="absolute top-0 left-0 w-full"
              style={`transform: translateY(${row.start}px);`}
              data-testid="virtual-row"
              data-index={row.index}
              use:measureRow
            >
              {@render Row({
                link,
                collection,
                selected: link.id === cursorId,
                checked: checked.has(link.id),
                isStale,
                displayTitle,
                showHost: items[row.index - 1]?.host !== link.host,
                onClick: (e: MouseEvent) => onRowClick(link, e),
              })}
            </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div class="plain-list">
          {#each items as link, i (link.id)}
            {@render Row({
              link,
              collection,
              selected: link.id === cursorId,
              checked: checked.has(link.id),
              isStale,
              displayTitle,
              showHost: items[i - 1]?.host !== link.host,
              onClick: (e: MouseEvent) => onRowClick(link, e),
            })}
          {/each}
        </div>
      {/if}
      {#if total > items.length}
        <div class="sentinel" bind:this={sentinelEl} data-testid="list-sentinel" aria-hidden="true"></div>
      {/if}
      {#if query.isFetching && items.length > 0}
        <div class="list-loading meta" data-testid="list-loading" role="status">{m.list_loading()}</div>
      {/if}
    </div>
  {/if}

  <!-- A5: footer key-hints are gone; the ? button opens the help dialog
       (?dialog=help — same URL mechanism as the ingest dialog). -->
  <footer class="list-foot">
    <button
      type="button"
      class="btn btn-ghost btn-icon help-btn"
      aria-label={m.help_aria()}
      title={m.help_title()}
      onclick={() => setUrl({ dialog: 'help' })}
      data-testid="help-button"
    >
      <IconCircleQuestionMark width={15} height={15} aria-hidden="true" />
    </button>
  </footer>
</div>

{#snippet Row(props: {
  link: LinkSummary
  collection: string
  selected: boolean
  checked: boolean
  isStale: (l: LinkSummary) => boolean
  displayTitle: (l: LinkSummary) => string
  showHost: boolean
  onClick: (e: MouseEvent) => void
})}
  {@const link = props.link}
  {@const meta = collectionMeta(props.collection)}
  {@const headline = props.displayTitle(link)}
  <button
    type="button"
    class="list-row"
    class:is-selected={props.selected}
    class:is-dim={props.checked}
    data-testid="link-row"
    data-link-id={link.id}
    onclick={props.onClick}
    oncontextmenu={(e) => onRowContextMenu(link, e)}
  >
    <span class="row-check" aria-hidden="true">{props.checked ? '☑' : ''}</span>
    <span class="row-main">
      <span class="row-line1">
        <span
          class="row-dot chip-state-{meta.tone}"
          title={meta.label}
          data-testid="state-dot"
        ></span>
        {#if props.showHost}
          <span class="row-host meta">{link.host ?? hostOf(link.url)}</span>
        {/if}
        <span class="meta row-time">{timeAgo(link.updated_at)}</span>
        {#if link.read_minutes > 0}<span class="meta">{link.read_minutes}m</span>{/if}
        {#if link.reason}
          <span class="row-reason meta">
            {reasonLabel(link.reason)}{#if link.next_attempt_at} · {m.row_retry({ time: timeAgo(link.next_attempt_at) })}{/if}
          </span>
        {/if}
        <span class="row-icons">
          {#if link.category}<IconChip icon={categoryIcon(link.category)} label={link.category} />{/if}
          {#if link.priority === 'high'}<IconChip icon={IconFlame} label={m.priority_high()} accent />{/if}
          {#if props.isStale(link)}<IconChip icon={IconClock} label={m.chip_stale()} tone="blocked" />{/if}
        </span>
      </span>
      <span class="row-title" title={headline} data-testid="row-title">{headline}</span>
      {#if headline !== link.url}
        <span class="row-url meta" title={link.url} data-testid="row-url">{link.url}</span>
      {/if}
    </span>
  </button>
{/snippet}

<style>
  .listpane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .list-head {
    padding: 14px 14px 10px;
    border-bottom: 1px solid var(--color-line);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .list-title-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .list-title {
    font-size: 20px;
  }
  /* A4: filter button on the left, search centered in the remaining space,
     spare slot on the right keeps the input visually centered. */
  .search-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .search-side {
    position: relative;
    display: flex;
    align-items: center;
    flex: none;
    min-width: 0;
  }
  .search-side-end {
    flex: none;
  }
  .filter-anchor {
    display: contents;
  }
  .filter-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .filter-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--color-accent);
    flex: none;
  }
  .search-center {
    flex: 1;
    display: flex;
    justify-content: center;
    min-width: 0;
  }
  .search-input {
    width: 100%;
    max-width: 400px;
    min-width: 0;
  }
  .chip-button {
    cursor: pointer;
  }
  .filter-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .list-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
  }
  .plain-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .list-foot {
    display: flex;
    justify-content: flex-end;
    padding: 2px 8px;
    border-top: 1px solid var(--color-line);
  }
  .help-btn {
    color: var(--color-ink-faint);
  }
  .help-btn:hover {
    color: var(--color-ink);
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }
  .empty-card {
    padding: 28px 32px;
    text-align: center;
    max-width: 340px;
  }
  .empty-title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .row-check {
    width: 16px;
    flex: none;
    text-align: center;
    color: var(--color-accent);
    font-size: 13px;
    padding-top: 2px;
  }
  .row-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .row-line1 {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .row-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
    flex: none;
  }
  .row-host {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 30%;
    flex: none;
  }
  .row-time {
    flex: none;
  }
  .row-reason {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 1 auto;
  }
  .row-icons {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    flex: none;
  }
  .row-title {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--color-ink);
    /* A3: single-line ellipsis (~80 chars at the default column width). */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sentinel {
    height: 1px;
  }
  .list-loading {
    display: flex;
    justify-content: center;
    padding: 8px 0 4px;
  }
  /* Density=compact tightens rows, header and meta lines (A2). */
  .listpane.density-compact .list-head {
    padding: 10px 12px 8px;
    gap: 6px;
  }
  .listpane.density-compact .list-title {
    font-size: 17px;
  }
  .listpane.density-compact .list-row {
    padding: 6px 10px;
    gap: 8px;
  }
  .listpane.density-compact .row-title {
    font-size: 13px;
  }
  .listpane.density-compact .row-url {
    font-size: 12px;
  }
  .listpane.density-compact .row-reason {
    font-size: 11px;
  }
  .row-url {
    font-size: 12.5px;
    line-height: 1.45;
  }
  .row-reason {
    font-size: 11.5px;
  }
</style>
