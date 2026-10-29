<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import type { LinkSummary } from '../lib/types'

  const queryClient = useQueryClient()

  const query = createQuery(() => ({
    queryKey: ['sweep'],
    queryFn: () => api.sweep(),
  }))

  let applying = $state(false)
  let result = $state<string | null>(null)

  const groups = $derived(query.data?.groups ?? [])
  const total = $derived(groups.reduce((n, g) => n + g.links.length, 0))

  async function apply() {
    applying = true
    try {
      const res = await api.sweepApply()
      result = `Archived ${res.archived} links`
      await queryClient.invalidateQueries({ queryKey: ['sweep'] })
      await queryClient.invalidateQueries({ queryKey: ['links'] })
    } finally {
      applying = false
    }
  }
</script>

<div class="mx-auto w-full max-w-3xl p-3 md:p-6 space-y-3">
  <header class="flex items-center justify-between gap-2">
    <h1 class="text-xl font-semibold">Sweep</h1>
    <span class="text-sm text-base-content/60" data-testid="sweep-total">{total} expired</span>
  </header>

  {#if query.isPending}
    <div class="skeleton h-24 w-full"></div>
  {:else if query.isError}
    <div class="alert alert-error">Failed to load sweep.</div>
  {:else if groups.length === 0}
    <div class="alert alert-success" data-testid="sweep-empty">Nothing to sweep.</div>
  {:else}
    {#if result}
      <div class="alert alert-success" data-testid="sweep-result">{result}</div>
    {/if}
    <button class="btn btn-primary btn-sm" data-testid="sweep-apply" disabled={applying} onclick={apply}>
      {applying ? 'Applying' : 'Archive all expired'}
    </button>

    {#each groups as group (group.category)}
      <section class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 gap-2">
          <h2 class="font-medium flex items-center gap-2">
            <span class="badge badge-sm">{group.category}</span>
            <span class="text-base-content/60 text-sm">{group.links.length}</span>
          </h2>
          <ul class="divide-y divide-base-300">
            {#each group.links as link (link.id)}
              {@const l = link as LinkSummary}
              <li class="py-2">
                <span class="font-medium">{l.title || l.url}</span>
                <span class="block text-sm text-base-content/60">
                  expired {l.expires_at ? new Date(l.expires_at).toLocaleDateString() : 'unknown'}
                  {#if l.expiry_reason}
                    - {l.expiry_reason}
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      </section>
    {/each}
  {/if}
</div>
