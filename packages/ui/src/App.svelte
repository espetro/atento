<script lang="ts">
  import { onMount } from 'svelte'
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import { createQueryClient } from './lib/api'
  import { parseUrlState, toUrlState, type UrlState } from './lib/urlState'
  import { startKeyboard, onShortcut } from './lib/keyboard'
  import Triage from './views/Triage.svelte'
  import Attention from './views/Attention.svelte'
  import RunStatus from './views/RunStatus.svelte'
  import Settings from './views/Settings.svelte'
  import Metrics from './views/Metrics.svelte'
  import IngestDialog from './views/IngestDialog.svelte'
  import Dialog from './components/Dialog.svelte'
  import LiveSync from './components/LiveSync.svelte'
  import { sseConnected } from './lib/events'

  const queryClient = createQueryClient()

  let url = $state<UrlState>(parseUrlState(new URLSearchParams(window.location.search)))
  let keymapOpen = $state(false)

  function setUrl(next: Partial<UrlState>) {
    url = { ...url, ...next }
    const qs = toUrlState(url).toString()
    history.pushState(null, '', qs ? `?${qs}` : window.location.pathname)
  }

  onMount(() => {
    startKeyboard()
    const onPop = () => {
      url = parseUrlState(new URLSearchParams(window.location.search))
    }
    window.addEventListener('popstate', onPop)
    const offKeymap = onShortcut('?', () => (keymapOpen = true))
    return () => {
      window.removeEventListener('popstate', onPop)
      offKeymap()
    }
  })
</script>

<QueryClientProvider client={queryClient}>
  <LiveSync />
  <div class="app-shell" data-testid="app-shell">
    <main class="app-main">
      {#if url.view === 'attention'}
        <Attention {url} {setUrl} />
      {:else if url.view === 'run'}
        <RunStatus {url} {setUrl} />
      {:else if url.view === 'settings'}
        <Settings {url} {setUrl} />
      {:else if url.view === 'metrics'}
        <Metrics />
      {:else}
        <Triage {url} {setUrl} />
      {/if}
    </main>
    {#if url.dialog === 'ingest'}
      <IngestDialog open={true} {setUrl} />
    {/if}
    {#if !$sseConnected}
      <div class="sse-chip" role="status" data-testid="sse-reconnecting">reconnecting…</div>
    {/if}
  </div>
</QueryClientProvider>

<Dialog open={keymapOpen} labelledBy="keymap-title" onClose={() => (keymapOpen = false)}>
  <div class="keymap">
    <h2 id="keymap-title" class="keymap-title">Keyboard</h2>
    <table class="keymap-table">
      <tbody>
        <tr><td><kbd class="kbd">j</kbd> <kbd class="kbd">k</kbd></td><td>move selection</td></tr>
        <tr><td><kbd class="kbd">/</kbd></td><td>focus search</td></tr>
        <tr><td><kbd class="kbd">a</kbd> <kbd class="kbd">s</kbd> <kbd class="kbd">d</kbd></td><td>archive / schedule / discard</td></tr>
        <tr><td><kbd class="kbd">r</kbd></td><td>re-extract</td></tr>
        <tr><td><kbd class="kbd">o</kbd></td><td>open link in browser</td></tr>
        <tr><td><kbd class="kbd">1</kbd>–<kbd class="kbd">4</kbd></td><td>Reader / Metadata / Snapshot / Live</td></tr>
        <tr><td><kbd class="kbd">?</kbd></td><td>this overlay</td></tr>
      </tbody>
    </table>
  </div>
</Dialog>

<style>
  .app-shell {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .app-main {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .keymap {
    min-width: 320px;
    padding: 8px;
  }
  .keymap-title {
    font-size: 16px;
    margin-bottom: 10px;
  }
  .keymap-table {
    border-collapse: collapse;
    font-size: 13px;
  }
  .keymap-table td {
    padding: 4px 14px 4px 0;
  }
  .keymap-table td:last-child {
    color: var(--color-ink-soft);
  }
  .sse-chip {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 70;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--color-ink-soft);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    box-shadow: var(--shadow-pop, 0 4px 14px rgba(0, 0, 0, 0.1));
  }
</style>
