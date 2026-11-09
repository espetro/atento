<script lang="ts">
  import { onMount } from 'svelte'
  import { isDesktopShell, showNativePreview, resetNativePreviewPool } from '../desktop'
  import { m } from '../../paraglide/messages.js'

  /**
   * Native preview slot for the Electrobun desktop shell (B1). Renders a
   * plain div; showNativePreview() appends pooled <electrobun-webview>
   * elements into it — the tag composites a real native webview over its
   * own rect, tracking scroll/resize automatically.
   *
   * Only mounted when isDesktopShell() is true; on plain web the caller
   * renders the reader/snapshot fallback instead.
   */
  let { url }: { url: string } = $props()

  let host: HTMLDivElement | undefined = $state()

  // $effect covers both mount and url changes; showNativePreview is
  // idempotent for a repeated (container, url) pair.
  $effect(() => {
    if (host && url) showNativePreview(host, url)
  })

  onMount(() => {
    return () => resetNativePreviewPool()
  })
</script>

<div
  class="native-preview"
  bind:this={host}
  data-testid="native-preview"
  role="region"
  aria-label={m.native_preview_label()}
></div>

<style>
  /* Fixed-height in-flow slot: the scrollable panel keeps its density, the
     native layer tracks this rect via Electrobun's overlay sync. */
  .native-preview {
    position: relative;
    height: min(520px, 55vh);
    min-height: 240px;
    border: 1px solid var(--color-line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-surface, #fff);
  }
  :global(.native-preview-wv) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }
</style>
