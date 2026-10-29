<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { marked } from 'marked'
  import { api } from '../lib/api'
  import type { LinkAction } from '../lib/types'

  let {
    id,
    onClose,
    onAction,
  }: { id: number; onClose: () => void; onAction: (id: number, action: LinkAction) => void } =
    $props()

  const query = createQuery(() => ({
    queryKey: ['link', id],
    queryFn: () => api.link(id),
  }))

  const rendered = $derived(
    query.data ? marked.parse(query.data.extracted_content, { async: false }) : '',
  )
</script>

<div class="fixed inset-0 z-40">
  <button
    type="button"
    class="absolute inset-0 bg-base-content/40 cursor-default"
    aria-label="Close drawer"
    data-testid="drawer-backdrop"
    onclick={onClose}
  ></button>
  <aside
    class="absolute right-0 top-0 h-full w-full sm:w-[32rem] max-w-full bg-base-100 border-l border-base-300 flex flex-col drawer-content"
    data-testid="detail-drawer"
  >
    <header class="flex items-center justify-between p-4 border-b border-base-300 gap-2">
      <h2 class="font-semibold text-lg truncate" data-testid="drawer-title">
        {query.data ? query.data.title || query.data.url : 'Loading'}
      </h2>
      <button class="btn btn-circle btn-ghost btn-sm" data-testid="drawer-close" onclick={onClose} aria-label="Close">
        ✕
      </button>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      {#if query.isPending}
        <div class="skeleton h-24 w-full"></div>
      {:else if query.isError || !query.data}
        <p class="text-error" data-testid="drawer-error">Failed to load link.</p>
      {:else}
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <a class="link link-primary break-all" href={query.data.url} target="_blank" rel="noopener">{query.data.url}</a>
          <span class="badge badge-outline badge-sm">{query.data.category}</span>
          <span class="badge badge-outline badge-sm">{query.data.read_minutes} min</span>
        </div>

        {#if query.data.expires_at}
          <div class="alert alert-warning py-2 text-sm" data-testid="expiry-info">
            <span>
              Expires {new Date(query.data.expires_at).toLocaleString()}
              {#if query.data.expiry_reason}
                <span class="opacity-70">({query.data.expiry_reason})</span>
              {/if}
            </span>
          </div>
        {/if}

        <section>
          <h3 class="font-medium mb-2">Extracted content</h3>
          <div class="prose prose-sm max-w-none" data-testid="drawer-markdown">{@html rendered}</div>
        </section>

        <section>
          <h3 class="font-medium mb-2">Enrichment</h3>
          <div class="mockup-code bg-base-200 text-xs p-4" data-testid="drawer-enrichment">
            <pre><code>{JSON.stringify(query.data.enrichment, null, 2)}</code></pre>
          </div>
          <p class="text-xs text-base-content/60 mt-1">confidence: {query.data.confidence}</p>
        </section>
      {/if}
    </div>

    {#if query.data}
      <footer class="flex flex-wrap gap-2 p-4 border-t border-base-300">
        <button class="btn btn-primary btn-sm" data-testid="drawer-action-read_now" onclick={() => onAction(id, 'read_now')}>Read now</button>
        <button class="btn btn-outline btn-sm" data-testid="drawer-action-schedule" onclick={() => onAction(id, 'schedule')}>Schedule</button>
        <button class="btn btn-outline btn-sm" data-testid="drawer-action-archive" onclick={() => onAction(id, 'archive')}>Archive</button>
        <button class="btn btn-ghost btn-sm text-error" data-testid="drawer-action-discard" onclick={() => onAction(id, 'discard')}>Discard</button>
      </footer>
    {/if}
  </aside>
</div>
