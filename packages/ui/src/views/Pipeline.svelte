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

<div class="mx-auto w-full max-w-4xl p-3 md:p-6 space-y-3">
  <header class="flex items-center justify-between gap-2">
    <h1 class="text-xl font-semibold">Pipeline</h1>
    <span class="text-sm text-base-content/60" data-testid="pipeline-total">{total} links</span>
  </header>

  <!-- State filter chips with counts -->
  <div class="flex flex-wrap gap-1.5" data-testid="state-chips">
    <button
      type="button"
      class="join-item btn btn-xs {url.state === '' ? 'btn-primary' : 'btn-outline'}"
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
        class="btn btn-xs {url.state === s ? 'btn-primary' : 'btn-outline'}"
        data-testid="state-chip"
        data-state={s}
        onclick={() => {
          limit = PAGE
          setUrl({ state: s })
        }}
      >
        {s}
        {#if byState && byState[s] > 0}
          <span class="badge badge-ghost badge-sm">{byState[s]}</span>
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
    <div class="overflow-x-auto" data-testid="pipeline-list">
      <table class="table table-sm">
        <thead>
          <tr>
            <th>State</th>
            <th>Reason</th>
            <th>Host</th>
            <th>Title</th>
            <th>Next retry</th>
          </tr>
        </thead>
        <tbody>
          {#each items as item (item.id)}
            <tr
              class="hover cursor-pointer"
              data-testid="pipeline-row"
              data-link-id={item.id}
              onclick={() => setUrl({ selected: item.id })}
            >
              <td>{#if item.state}<StateBadge state={item.state} />{/if}</td>
              <td class="text-sm text-base-content/70" data-testid="row-reason">{item.reason ?? ''}</td>
              <td class="text-sm whitespace-nowrap" data-testid="row-host">{item.host ?? ''}</td>
              <td class="max-w-0">
                <button
                  type="button"
                  class="text-left block truncate max-w-[16rem] hover:underline"
                  data-testid="row-title"
                  onclick={(e) => {
                    e.stopPropagation()
                    setUrl({ selected: item.id })
                  }}
                >
                  {item.title || item.url}
                </button>
              </td>
              <td class="text-sm whitespace-nowrap text-base-content/60">
                {shortTime(item.next_attempt_at)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

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
