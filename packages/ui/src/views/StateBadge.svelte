<script lang="ts">
  import type { PipelineState } from '../lib/types'

  let { state }: { state: PipelineState } = $props()

  // Semantic daisyUI badge colours only: no raw Tailwind palette, so dark
  // mode keeps working. Processing states are info, blocked states warning,
  // failed states error, done/triage states neutral/success.
  const badgeClass: Record<PipelineState, string> = {
    created: 'badge-neutral',
    extracting: 'badge-info',
    extracted: 'badge-info',
    needs_browser: 'badge-warning',
    deferred: 'badge-warning',
    enriching: 'badge-info',
    inbox: 'badge-primary',
    scheduled: 'badge-secondary',
    archived: 'badge-ghost',
    discarded: 'badge-ghost',
    errored: 'badge-error',
    deleted: 'badge-ghost',
  }
</script>

<span
  class="badge badge-sm {badgeClass[state] ?? 'badge-neutral'}"
  data-testid="state-badge"
>{state}</span>
