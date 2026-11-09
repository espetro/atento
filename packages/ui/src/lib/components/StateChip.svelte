<script lang="ts">
  import type { Snippet } from 'svelte'
  import { collectionMeta } from '../copy'

  let {
    collection,
    state,
    label,
    title,
  }: {
    /** Pipeline collection → chip-state tone + default label. */
    collection?: string
    /** Raw FSM state (fallback when no collection). */
    state?: string | null
    /** Explicit label override. */
    label?: string
    title?: string
  } = $props()

  const STATE_TONES: Record<string, string> = {
    created: 'pending',
    extracting: 'pending',
    extracted: 'pending',
    enriching: 'pending',
    inbox: 'enriched',
    deferred: 'pending',
    needs_browser: 'needs-login',
    scheduled: 'triaged',
    archived: 'triaged',
    discarded: 'triaged',
    errored: 'errored',
    deleted: 'triaged',
  }

  const tone = $derived(
    collection !== undefined && collection !== ''
      ? collectionMeta(collection).tone
      : state != null && state !== ''
        ? (STATE_TONES[state] ?? 'default')
        : 'default',
  )
  const text = $derived(
    label ??
      (collection !== undefined && collection !== ''
        ? collectionMeta(collection).label
        : (state ?? '').replace(/_/g, ' ') || '—'),
  )
</script>

<span class="chip chip-state-{tone}" title={title ?? text} data-testid="state-chip">
  <span class="dot" aria-hidden="true"></span>
  {text}
</span>
