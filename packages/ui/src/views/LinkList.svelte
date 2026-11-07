<script lang="ts">
  import { onMount } from 'svelte'
  import { createQuery } from '@tanstack/svelte-query'
  import { createVirtualizer } from '@tanstack/svelte-virtual'
  import { get } from 'svelte/store'
  import { api } from '../lib/api'
  import { onShortcut } from '../lib/keyboard'
  import { hostOf, timeAgo, truncate } from '../lib/format'
  import { collectionMeta, reasonLabel } from '../lib/copy'
  import type { UrlState } from '../lib/urlState'
  import type { LinkAction, LinkSummary } from '../lib/types'
  import { PIPELINE_STATES } from '../lib/types'
  import StateChip from '../components/StateChip.svelte'

  let {
    url,
    setUrl,
    collection,
    onTriage,
    onReextract,
    onOpenUrl,
    registerActions,
  }: {
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    /** Effective collection name (already resolved). */
    collection: string
    onTriage: (ids: number[], action: LinkAction) => Promise<void>
    onReextract: (link: LinkSummary) => void
    onOpenUrl: (url: string) => void
    /** Lets the parent read the current selection for its own shortcuts. */
    registerActions?: (actions: {
      selectedIds: () => number[]
      selectedLink: () => LinkSummary | null
    }) => void
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

  // Register once on mount; the closures read reactive state at call time.
  onMount(() => {
    registerActions?.({
      selectedIds: () => actionIds,
      selectedLink: () => items.find((l) => l.id === cursorId) ?? null,
    })
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
        const link = items.find((l) => l.id === cursorId)
        if (link) onReextract(link)
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
    estimateSize: () => 96,
    overscan: 8,
  })

  $effect(() => {
    get(virtualizerStore).setOptions({ count: items.length })
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

  const ATTENTION = new Set(['needs_login', 'blocked', 'errored', 'review'])
  const categories = ['ai', 'engineering', 'design', 'product', 'security', 'ops', 'reading']
  const meta = $derived(collectionMeta(collection))
  const hasActiveFilters = $derived(
    url.q !== '' || url.state !== '' || url.category !== '' || url.host !== '' || url.stale,
  )

  function clearFilters() {
    setUrl({ q: '', state: '', category: '', host: '', stale: false, selected: null })
    qInput = ''
  }

  function isStale(link: LinkSummary): boolean {
    return link.expires_at != null && new Date(link.expires_at).getTime() < Date.now()
  }

  function rowTitle(link: LinkSummary): string {
    return link.title !== '' ? link.title : link.url
  }
</script>

<div class="listpane" data-testid="link-list-pane">
  <header class="list-head">
    <div class="list-title-row">
      <h1 class="list-title">{meta.label}</h1>
      <span class="meta" data-testid="total-count">{total} items</span>
    </div>
    <div class="search-row">
      <input
        bind:this={searchEl}
        class="input search-input"
        type="search"
        placeholder="/ search titles & urls"
        aria-label="Search links"
        data-testid="search-input"
        bind:value={qInput}
        oninput={onSearchInput}
      />
      <select
        class="select filter-select"
        aria-label="Filter by state"
        data-testid="state-filter"
        value={url.state}
        onchange={(e) => setUrl({ state: (e.currentTarget as HTMLSelectElement).value, selected: null })}
      >
        <option value="">all states</option>
        {#each PIPELINE_STATES as s (s)}
          <option value={s}>{s.replace(/_/g, ' ')}</option>
        {/each}
      </select>
      <select
        class="select filter-select"
        aria-label="Filter by category"
        data-testid="category-filter"
        value={url.category}
        onchange={(e) => setUrl({ category: (e.currentTarget as HTMLSelectElement).value, selected: null })}
      >
        <option value="">all categories</option>
        {#each categories as c (c)}
          <option value={c}>{c}</option>
        {/each}
      </select>
      <label class="chip chip-toggle" class:chip-accent={url.stale}>
        <input
          type="checkbox"
          checked={url.stale}
          onchange={(e) => setUrl({ stale: (e.currentTarget as HTMLInputElement).checked, selected: null })}
        />
        stale
      </label>
    </div>
    {#if hasActiveFilters}
      <div class="filter-chips">
        {#if url.q}<button class="chip chip-button" onclick={() => { qInput = ''; setUrl({ q: '', selected: null }) }}>“{truncate(url.q, 30)}” ✕</button>{/if}
        {#if url.state}<button class="chip chip-button" onclick={() => setUrl({ state: '', selected: null })}>state: {url.state.replace(/_/g, ' ')} ✕</button>{/if}
        {#if url.category}<button class="chip chip-button" onclick={() => setUrl({ category: '', selected: null })}>cat: {url.category} ✕</button>{/if}
        {#if url.host}<button class="chip chip-button" onclick={() => setUrl({ host: '', selected: null })}>host: {url.host} ✕</button>{/if}
        {#if url.stale}<button class="chip chip-button" onclick={() => setUrl({ stale: false, selected: null })}>stale ✕</button>{/if}
        <button class="chip chip-button" onclick={clearFilters}>clear all</button>
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
        Failed to load links.
        <button class="btn btn-sm" onclick={() => void query.refetch()}>retry</button>
      </div>
    </div>
  {:else if items.length === 0}
    <div class="list-body empty">
      <div class="empty-card pane">
        <p class="empty-title">{meta.label} is empty</p>
        <p class="meta">
          {#if collection === 'pending'}
            Links appear here while the pipeline works on them — run a pass to move things along.
          {:else if ATTENTION.has(collection)}
            Nothing needs attention here right now.
          {:else}
            No links in this collection yet.
          {/if}
        </p>
      </div>
    </div>
  {:else}
    <div class="list-body scroll-thin" bind:this={scrollEl} data-testid="link-list">
      {#if items.length > 12}
        <div class="relative w-full" style={`height: ${$virtualizerStore.getTotalSize()}px;`}>
          {#each $virtualizerStore.getVirtualItems() as row (row.key)}
            {@const link = items[row.index]!}
            <div
              class="absolute top-0 left-0 w-full"
              style={`transform: translateY(${row.start}px);`}
              data-testid="virtual-row"
            >
              {@render Row({
                link,
                collection,
                selected: link.id === cursorId,
                checked: checked.has(link.id),
                isStale,
                rowTitle,
                onClick: (e: MouseEvent) => onRowClick(link, e),
              })}
            </div>
          {/each}
        </div>
      {:else}
        <div class="plain-list">
          {#each items as link (link.id)}
            {@render Row({
              link,
              collection,
              selected: link.id === cursorId,
              checked: checked.has(link.id),
              isStale,
              rowTitle,
              onClick: (e: MouseEvent) => onRowClick(link, e),
            })}
          {/each}
        </div>
      {/if}
    </div>

    {#if total > items.length}
      <footer class="list-foot">
        <button class="btn btn-sm" data-testid="load-more" onclick={() => (limit += PAGE)}>
          load more · {total - items.length} remaining
        </button>
      </footer>
    {/if}
  {/if}
</div>

{#snippet Row(props: {
  link: LinkSummary
  collection: string
  selected: boolean
  checked: boolean
  isStale: (l: LinkSummary) => boolean
  rowTitle: (l: LinkSummary) => string
  onClick: (e: MouseEvent) => void
})}
  {@const link = props.link}
  {@const meta = collectionMeta(props.collection)}
  <button
    type="button"
    class="list-row"
    class:is-selected={props.selected}
    class:is-dim={props.checked}
    data-testid="link-row"
    data-link-id={link.id}
    onclick={props.onClick}
  >
    <span class="row-check" aria-hidden="true">{props.checked ? '☑' : ''}</span>
    <span class="row-main">
      <span class="row-line1">
        <StateChip collection={props.collection} state={link.state} label={undefined} />
        <span class="row-host meta">{link.host ?? hostOf(link.url)}</span>
        {#if link.category}<span class="chip">{link.category}</span>{/if}
        {#if link.priority === 'high'}<span class="chip chip-accent">high</span>{/if}
        {#if link.read_minutes > 0}<span class="meta">{link.read_minutes}m</span>{/if}
        {#if props.isStale(link)}<span class="chip chip-state-blocked">stale</span>{/if}
      </span>
      <span class="row-title truncate-2" data-testid="row-title">{props.rowTitle(link)}</span>
      {#if link.why_it_matters}
        <span class="row-why meta truncate-2">{truncate(link.why_it_matters, 200)}</span>
      {/if}
      {#if link.reason || link.next_attempt_at}
        <span class="row-reason meta">
          {reasonLabel(link.reason)}
          {#if link.next_attempt_at}· retry {timeAgo(link.next_attempt_at)}{/if}
        </span>
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
  .search-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search-input {
    flex: 1;
    min-width: 0;
  }
  .filter-select {
    width: auto;
    padding: 6px 8px;
    font-size: 12.5px;
  }
  .chip-toggle {
    cursor: pointer;
    user-select: none;
  }
  .chip-toggle input {
    accent-color: var(--color-accent);
    margin: 0;
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
    justify-content: center;
    padding: 10px;
    border-top: 1px solid var(--color-line);
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
    flex-wrap: wrap;
  }
  .row-host {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 45%;
  }
  .row-title {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--color-ink);
  }
  .row-why {
    font-size: 12.5px;
    line-height: 1.45;
  }
  .row-reason {
    font-size: 11.5px;
  }
</style>
