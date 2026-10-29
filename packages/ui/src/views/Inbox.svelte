<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual'

  type VirtualizerInstance = SvelteVirtualizer<HTMLElement, Element>
  import { api } from '../lib/api'
  import type { UrlState } from '../lib/urlState'
  import type { LinkAction, LinkSummary } from '../lib/types'
  import LinkCard from './LinkCard.svelte'
  import DetailDrawer from './DetailDrawer.svelte'

  let {
    url,
    setUrl,
  }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()

  const PAGE = 50
  let limit = $state(PAGE)

  const categories = ['ai', 'engineering', 'design', 'product', 'security', 'ops', 'reading']

  const query = createQuery(() => ({
    queryKey: ['links', url.status, url.category, url.q, limit],
    queryFn: () =>
      api.links({
        status: url.status as never,
        category: url.category,
        q: url.q,
        limit,
        offset: 0,
      }),
  }))

  const items = $derived<LinkSummary[]>(query.data?.items ?? [])
  const total = $derived(query.data?.total ?? 0)

  let scrollEl = $state<HTMLElement | null>(null)

  const virtualizerStore = createVirtualizer({
    count: 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => 190,
    overscan: 6,
  })

  // The underlying Virtualizer instance is mutated in place, so store
  // emissions carry the same object identity. A version counter forces the
  // derived range to recompute whenever the instance reports a change.
  let virtualVersion = $state(0)
  let virtualizer = $state<VirtualizerInstance | null>(null)

  $effect(() => {
    if (!scrollEl) return
    const unsub = virtualizerStore.subscribe((instance) => {
      virtualizer = instance
    })
    return () => {
      unsub()
      virtualizer = null
    }
  })

  $effect(() => {
    if (!virtualizer) return
    virtualizer.setOptions({
      count: items.length,
      getScrollElement: () => scrollEl,
      onChange: () => {
        virtualVersion++
      },
    })
  })

  const virtualRows = $derived.by(() => {
    void virtualVersion
    if (!virtualizer) return [] as { index: number; key: number; start: number; size: number }[]
    return virtualizer.getVirtualItems()
  })

  async function onAction(id: number, action: LinkAction) {
    await api.triage([id], action)
    await queryClient.invalidateQueries({ queryKey: ['links'] })
    if (url.selected === id) setUrl({ selected: null })
  }
</script>

<div class="mx-auto w-full max-w-3xl p-3 md:p-6 space-y-3">
  <header class="flex items-center justify-between gap-2">
    <h1 class="text-xl font-semibold">Inbox</h1>
    <span class="text-sm text-base-content/60" data-testid="total-count">{total} items</span>
  </header>

  <div class="flex flex-col gap-2 sm:flex-row">
    <label class="input input-bordered flex items-center gap-2 w-full">
      <svg class="w-4 h-4 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        class="grow"
        placeholder="Search links"
        aria-label="Search links"
        data-testid="search-input"
        value={url.q}
        oninput={(e) => {
          limit = PAGE
          setUrl({ q: (e.currentTarget as HTMLInputElement).value })
        }}
      />
    </label>

    <select
      class="select select-bordered w-full sm:w-40"
      aria-label="Filter by status"
      data-testid="status-filter"
      value={url.status}
      onchange={(e) => {
        limit = PAGE
        setUrl({ status: (e.currentTarget as HTMLSelectElement).value })
      }}
    >
      <option value="">All statuses</option>
      <option value="inbox">Inbox</option>
      <option value="scheduled">Scheduled</option>
      <option value="archived">Archived</option>
      <option value="discarded">Discarded</option>
    </select>

    <select
      class="select select-bordered w-full sm:w-40"
      aria-label="Filter by category"
      data-testid="category-filter"
      value={url.category}
      onchange={(e) => {
        limit = PAGE
        setUrl({ category: (e.currentTarget as HTMLSelectElement).value })
      }}
    >
      <option value="">All categories</option>
      {#each categories as c (c)}
        <option value={c}>{c}</option>
      {/each}
    </select>
  </div>

  {#if query.isPending}
    <div class="space-y-2">
      {#each Array(6) as _, i (i)}
        <div class="skeleton h-40 w-full"></div>
      {/each}
    </div>
  {:else if query.isError}
    <div class="alert alert-error" data-testid="inbox-error">Failed to load links.</div>
  {:else if items.length === 0}
    <div class="alert" data-testid="empty-state">No links match the current filters.</div>
  {:else}
    <div
      class="overflow-y-auto"
      bind:this={scrollEl}
      data-testid="link-list"
      style={items.length > 20 ? 'height: calc(100dvh - 16rem);' : ''}
    >
      {#if items.length > 20}
      <div class="relative w-full" data-testid="vsize" style={`height: ${virtualRows.length > 0 ? (virtualizer?.getTotalSize() ?? 0) : 0}px;`}>
        {#each virtualRows as row (row.key)}
          <div
            class="absolute top-0 left-0 w-full pb-2"
            style={`transform: translateY(${row.start}px);`}
            data-testid="virtual-row"
          >
            <LinkCard
              link={items[row.index]}
              onAction={onAction}
              onOpen={(id) => setUrl({ selected: id })}
            />
          </div>
        {/each}
      </div>
      {/if}
      {#if !(items.length > 20)}
        <div class="space-y-2" data-testid="plain-list">
          {#each items as item (item.id)}
            <LinkCard
              link={item}
              onAction={onAction}
              onOpen={(id) => setUrl({ selected: id })}
            />
          {/each}
        </div>
      {/if}
    </div>

    {#if total > limit}
      <div class="flex justify-center">
        <button
          class="btn btn-outline btn-sm"
          data-testid="load-more"
          onclick={() => (limit += PAGE)}
        >
          Load more ({total - limit} remaining)
        </button>
      </div>
    {/if}
  {/if}
</div>

{#if url.selected != null}
  <DetailDrawer id={url.selected} onClose={() => setUrl({ selected: null })} onAction={onAction} />
{/if}
