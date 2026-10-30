<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import type { UrlState } from '../lib/urlState'
  import type { LinkSummary, PipelineState } from '../lib/types'
  import { PIPELINE_STATES } from '../lib/types'
  import StateBadge from './StateBadge.svelte'
  import DetailDrawer from './DetailDrawer.svelte'

  let {
    url,
    setUrl,
  }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()

  const PAGE = 50
  let limit = $state(PAGE)

  // The state histogram drives the filter chips; it doubles as the host
  // source so the host select offers only hosts that actually have links.
  const overview = createQuery(() => ({
    queryKey: ['pipeline'],
    queryFn: () => api.pipeline(),
  }))

  const query = createQuery(() => ({
    queryKey: ['pipeline-links', url.state, url.host, url.q, limit],
    queryFn: () =>
      api.links({
        state: url.state,
        host: url.host,
        q: url.q,
        limit,
        offset: 0,
      }),
  }))

  const items = $derived<LinkSummary[]>(query.data?.items ?? [])
  const total = $derived(query.data?.total ?? 0)
  const byState = $derived(overview.data?.byState ?? null)
  const hosts = $derived(overview.data?.byHost ?? [])

  function shortTime(iso: string | null | undefined): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }

  async function onAction(id: number, action: LinkSummary['action']) {
    await api.triage([id], action)
    await queryClient.invalidateQueries({ queryKey: ['pipeline-links'] })
    await queryClient.invalidateQueries({ queryKey: ['pipeline'] })
    if (url.selected === id) setUrl({ selected: null })
  }
</script>

<div class="mx-auto w-full max-w-4xl lg:max-w-6xl p-3 md:p-6 space-y-3">
  <header class="flex items-center justify-between gap-2">
    <h1 class="text-xl font-semibold">Pipeline</h1>
    <span class="text-sm text-base-content/60" data-testid="pipeline-total">
      {total} link{total === 1 ? '' : 's'}
    </span>
  </header>

  <!-- State filter chips with counts -->
  <div class="flex flex-wrap gap-1.5" data-testid="state-chips">
    <button
      type="button"
        class="join-item btn btn-xs min-h-9 {url.state === '' ? 'btn-primary' : 'btn-outline'}"
      data-testid="state-chip"
      data-state=""
      onclick={() => {
        limit = PAGE
        setUrl({ state: '' })
      }}
    >
      all
      {#if byState}
        <span class="badge badge-ghost badge-sm">
          {Object.values(byState).reduce((a, b) => a + b, 0)}
        </span>
      {/if}
    </button>
    {#each PIPELINE_STATES as s (s)}
      <button
        type="button"
        class="btn btn-xs min-h-9 {url.state === s ? 'btn-primary' : 'btn-outline'}"
        data-testid="state-chip"
        data-state={s}
        onclick={() => {
          limit = PAGE
          setUrl({ state: s })
        }}
      >
        {s}
        {#if byState}
          <span class="badge badge-ghost badge-sm" data-testid="state-count">{byState[s] ?? 0}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="flex flex-col gap-2 sm:flex-row">
    <label class="input input-bordered flex items-center gap-2 w-full">
      <svg class="w-4 h-4 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        class="grow"
        placeholder="Search url or title"
        aria-label="Search pipeline links"
        data-testid="pipeline-search"
        value={url.q}
        oninput={(e) => {
          limit = PAGE
          setUrl({ q: (e.currentTarget as HTMLInputElement).value })
        }}
      />
    </label>

    <select
      class="select select-bordered w-full sm:w-56"
      aria-label="Filter by host"
      data-testid="host-filter"
      value={url.host}
      onchange={(e) => {
        limit = PAGE
        setUrl({ host: (e.currentTarget as HTMLSelectElement).value })
      }}
    >
      <option value="">All hosts</option>
      {#each hosts as h (h.host)}
        <option value={h.host}>{h.host} ({h.total})</option>
      {/each}
    </select>
  </div>

  {#if query.isPending}
    <div class="space-y-2">
      {#each Array(6) as _, i (i)}
        <div class="skeleton h-12 w-full"></div>
      {/each}
    </div>
  {:else if query.isError}
    <div class="alert alert-error" data-testid="pipeline-error">Failed to load pipeline links.</div>
  {:else if items.length === 0}
    <div class="alert" data-testid="pipeline-empty">No links match the current filters.</div>
  {:else}
    <!-- Mobile-first rows: badge + title on the first line, the meta on the
         second. From lg the same rows reflow into a single grid line; the
         meta wrapper becomes display:contents so its cells join the grid. -->
    <ul data-testid="pipeline-list">
      <li
        class="hidden lg:flex gap-2 px-2 pb-1 text-xs uppercase tracking-wide text-base-content/50"
      >
        <span class="w-24 shrink-0">State</span>
        <span class="flex-1 min-w-0">Title</span>
        <span class="w-28 shrink-0">Reason</span>
        <span class="w-40 shrink-0">Host</span>
        <span class="w-32 shrink-0 text-right">Next retry</span>
      </li>
      {#each items as item (item.id)}
        <li
          class="grid grid-cols-[auto_1fr] lg:grid-cols-[6rem_minmax(0,1fr)_7rem_10rem_8rem] items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 hover:bg-base-200 cursor-pointer"
          data-testid="pipeline-row"
          data-link-id={item.id}
        >
          <span class="justify-self-start">
            {#if item.state}<StateBadge state={item.state} />{/if}
          </span>
          <span class="min-w-0">
            <button
              type="button"
              class="text-left block w-full truncate hover:underline"
              data-testid="row-title"
              title={item.title || item.url}
              onclick={() => setUrl({ selected: item.id })}
            >
              {item.title || item.url}
            </button>
          </span>
          <span class="col-span-2 lg:contents">
            <span
              class="flex gap-3 text-sm text-base-content/70 min-w-0 lg:block lg:w-28 lg:truncate"
              data-testid="row-reason"
            >
              {item.reason ?? ''}
            </span>
            <span
              class="flex gap-3 text-sm text-base-content/60 min-w-0 lg:block lg:w-40 lg:truncate"
              data-testid="row-host"
            >
              {item.host ?? ''}
            </span>
            <!-- Only deferred links carry a retry time, so mobile shows the
                 chip when there is one and the desktop column a muted dash. -->
            <span
              class="flex gap-3 text-sm text-base-content/60 min-w-0 lg:block lg:w-32 lg:text-right lg:whitespace-nowrap"
              data-testid="row-retry"
            >
              {#if item.next_attempt_at}
                <span class="badge badge-outline badge-sm lg:hidden">retry {shortTime(item.next_attempt_at)}</span>
                <span class="hidden lg:inline">{shortTime(item.next_attempt_at)}</span>
              {:else}
                <span class="hidden lg:inline text-base-content/30" aria-hidden="true">-</span>
              {/if}
            </span>
          </span>
        </li>
      {/each}
    </ul>

    {#if total > limit}
      <div class="flex justify-center">
        <button
          class="btn btn-outline btn-sm"
          data-testid="pipeline-load-more"
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
