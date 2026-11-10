<script lang="ts" module>
  import { SvelteMap } from 'svelte/reactivity'
  // Hosts whose cached favicon 404'd this session: skip the request next time.
  const failed = new SvelteMap<string, boolean>()
</script>

<script lang="ts">
  import { api } from '../api'

  /**
   * Site favicon served from the local favicon cache (`/api/favicon/:host`),
   * so it still renders offline. Falls back to a colored monogram tile.
   */
  let {
    host,
    hue,
    size = 20,
    class: className = '',
  }: { host: string; hue: number; size?: number; class?: string } = $props()

  const initial = $derived((host.replace(/^www\./, '')[0] ?? '?').toUpperCase())
  const missing = $derived(failed.get(host) === true)
</script>

<span
  class="site-avatar av-{hue} {className}"
  class:has-icon={!missing}
  style="width:{size}px;height:{size}px;border-radius:{Math.round(size * 0.3)}px"
  aria-hidden="true"
>
  {#if missing}
    {initial}
  {:else}
    <img
      class="site-favicon"
      src={api.faviconUrl(host)}
      alt=""
      loading="lazy"
      onerror={() => failed.set(host, true)}
      onload={(e) => {
        if ((e.currentTarget as HTMLImageElement).naturalWidth < 2) failed.set(host, true)
      }}
    />
  {/if}
</span>

<style>
  .site-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 650;
    flex: none;
    overflow: hidden;
  }
  .site-avatar.has-icon {
    background: transparent;
  }
  .site-favicon {
    width: 70%;
    height: 70%;
    border-radius: 3px;
    object-fit: contain;
  }
</style>
