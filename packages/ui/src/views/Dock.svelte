<script lang="ts">
  import type { UrlState } from '../lib/urlState'

  let { view, onNavigate }: { view: UrlState['view']; onNavigate: (v: UrlState['view']) => void } =
    $props()

  const items: { key: UrlState['view']; label: string; icon: string }[] = [
    { key: 'inbox', label: 'Inbox', icon: 'M3 12h18M3 6h18M3 18h18' },
    { key: 'sweep', label: 'Sweep', icon: 'M4 4h16v4H4zM4 12h10v8H4z' },
    { key: 'metrics', label: 'Metrics', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  ]
</script>

<div class="dock dock-sm bg-base-200 border-t border-base-300 w-full z-20" data-testid="dock">
  {#each items as item (item.key)}
    <button
      class={view === item.key ? 'dock-active' : ''}
      type="button"
      aria-label={item.label}
      aria-current={view === item.key ? 'page' : undefined}
      data-testid={`dock-${item.key}`}
      onclick={() => onNavigate(item.key)}
    >
      <svg
        class="w-5 h-5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d={item.icon} />
      </svg>
      <span class="dock-label">{item.label}</span>
    </button>
  {/each}
</div>
