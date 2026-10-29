<script lang="ts">
  import type { LinkAction, LinkSummary } from '../lib/types'

  let { link, onAction, onOpen }: {
    link: LinkSummary
    onAction: (id: number, action: LinkAction) => void
    onOpen: (id: number) => void
  } = $props()

  const priorityColor: Record<string, string> = {
    high: 'bg-error',
    normal: 'bg-warning',
    low: 'bg-base-content/30',
  }

  const stale = $derived(
    link.expires_at != null && new Date(link.expires_at).getTime() < Date.now(),
  )
</script>

<article class="card bg-base-200 border border-base-300" data-testid="link-card" data-link-id={link.id}>
  <div class="card-body p-4 gap-2">
    <div class="flex items-start gap-2">
      <span
        class="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 {priorityColor[link.priority] ?? 'bg-base-content/30'}"
        title={`priority: ${link.priority}`}
        data-testid="priority-dot"
      ></span>
      <button
        type="button"
        class="text-left font-medium leading-snug hover:underline flex-1 min-w-0"
        data-testid="link-title"
        onclick={() => onOpen(link.id)}
      >
        {link.title}
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="badge badge-outline badge-sm" data-testid="link-category">{link.category}</span>
      <span class="text-base-content/60">{link.read_minutes} min</span>
      {#if stale}
        <span class="badge badge-warning badge-sm" data-testid="stale-badge">stale</span>
      {/if}
    </div>

    <p class="text-sm text-base-content/70 line-clamp-2">{link.why_it_matters}</p>

    <div class="flex flex-wrap gap-1.5 mt-1">
      <button class="btn btn-primary btn-xs" data-testid="action-read_now" onclick={() => onAction(link.id, 'read_now')}>Read now</button>
      <button class="btn btn-outline btn-xs" data-testid="action-schedule" onclick={() => onAction(link.id, 'schedule')}>Schedule</button>
      <button class="btn btn-outline btn-xs" data-testid="action-archive" onclick={() => onAction(link.id, 'archive')}>Archive</button>
      <button class="btn btn-ghost btn-xs text-error" data-testid="action-discard" onclick={() => onAction(link.id, 'discard')}>Discard</button>
    </div>
  </div>
</article>
