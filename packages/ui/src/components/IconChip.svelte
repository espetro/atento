<script lang="ts">
  import type { Component } from 'svelte'

  /**
   * Icon-only chip (A3): media/type markers render as lucide icons with a
   * title + aria-label instead of a text label. `tone` maps to the
   * chip-state-* palette; `accent` uses the accent border.
   */
  let {
    icon: Icon,
    label,
    tone,
    accent = false,
  }: {
    icon: Component
    label: string
    tone?: string
    accent?: boolean
  } = $props()
</script>

<span
  class="chip chip-icon"
  class:chip-accent={accent}
  class:chip-state-enriched={tone === 'enriched'}
  class:chip-state-pending={tone === 'pending'}
  class:chip-state-needs-login={tone === 'needs-login'}
  class:chip-state-blocked={tone === 'blocked'}
  class:chip-state-errored={tone === 'errored'}
  class:chip-state-review={tone === 'review'}
  class:chip-state-triaged={tone === 'triaged'}
  class:chip-state-default={!tone}
  title={label}
  aria-label={label}
  role="img"
  data-testid="icon-chip"
>
  <Icon width={12} height={12} aria-hidden="true" />
</span>

<style>
  .chip-icon {
    padding: 1px 6px;
  }
  .chip-icon :global(svg) {
    display: block;
  }
</style>
