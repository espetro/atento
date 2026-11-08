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
  import CollectionsRail from './views/CollectionsRail.svelte'
  import IngestDialog from './views/IngestDialog.svelte'
  import Dialog from './components/Dialog.svelte'
  import LiveSync from './components/LiveSync.svelte'
  import { sseConnected } from './lib/events'
  import { m } from './paraglide/messages.js'

  const queryClient = createQueryClient()

  let url = $state<UrlState>(parseUrlState(new URLSearchParams(window.location.search)))
  let sheetOpen = $state(false)

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
    // '?' toggles the keyboard-help dialog; its open state lives in the URL
    // (?dialog=help) like the ingest dialog (A5).
    const offKeymap = onShortcut('?', () =>
      setUrl({ dialog: url.dialog === 'help' ? '' : 'help' }),
    )
    return () => {
      window.removeEventListener('popstate', onPop)
      offKeymap()
    }
  })
</script>

<QueryClientProvider client={queryClient}>
  <LiveSync />
  <div class="app-shell" data-testid="app-shell">
    <!-- Persistent rail: every view renders rail + content (A1). -->
    <CollectionsRail {url} {setUrl} />
    <div class="app-col">
      <!-- mobile top bar (<760px): the rail lives behind the sheet toggle -->
      <header class="mobile-bar">
        <button
          type="button"
          class="btn btn-ghost btn-icon"
          aria-label={m.aria_open_collections()}
          onclick={() => (sheetOpen = true)}
          data-testid="rail-toggle"
        >
          ☰
        </button>
        <button
          type="button"
          class="mobile-wordmark"
          onclick={() => setUrl({ view: 'triage', collection: 'enriched', selected: null })}
        >
          {m.app_name()}
        </button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => setUrl({ view: 'run', selected: null })}>{m.nav_run()}</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => setUrl({ view: 'settings', selected: null })}>⚙</button>
        <button type="button" class="btn btn-sm btn-primary" onclick={() => setUrl({ dialog: 'ingest' })} data-testid="mobile-ingest">⊕</button>
      </header>
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
    </div>
    {#if sheetOpen}
      <CollectionsRail {url} {setUrl} open={true} onClose={() => (sheetOpen = false)} />
    {/if}
    {#if url.dialog === 'ingest'}
      <IngestDialog open={true} {setUrl} />
    {/if}
    {#if !$sseConnected}
      <div class="sse-chip" role="status" data-testid="sse-reconnecting">{m.sse_reconnecting()}</div>
    {/if}
  </div>
</QueryClientProvider>

{#if url.dialog === 'help'}
  <Dialog open={true} labelledBy="keymap-title" onClose={() => setUrl({ dialog: '' })}>
  <div class="keymap">
    <h2 id="keymap-title" class="keymap-title">{m.keymap_title()}</h2>
    <table class="keymap-table">
      <tbody>
        <tr><td><kbd class="kbd">j</kbd> <kbd class="kbd">k</kbd></td><td>{m.keymap_move()}</td></tr>
        <tr><td><kbd class="kbd">/</kbd></td><td>{m.keymap_search()}</td></tr>
        <tr><td><kbd class="kbd">a</kbd> <kbd class="kbd">s</kbd> <kbd class="kbd">d</kbd></td><td>{m.keymap_actions()}</td></tr>
        <tr><td><kbd class="kbd">r</kbd></td><td>{m.keymap_reextract()}</td></tr>
        <tr><td><kbd class="kbd">o</kbd></td><td>{m.keymap_open()}</td></tr>
        <tr><td><kbd class="kbd">?</kbd></td><td>{m.keymap_help()}</td></tr>
      </tbody>
    </table>
  </div>
  </Dialog>
{/if}

<style>
  .app-shell {
    height: 100vh;
    height: 100dvh;
    display: flex;
    overflow: hidden;
  }
  .app-col {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .app-main {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .mobile-bar {
    display: none;
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
  .spacer {
    flex: 1;
  }
  .mobile-wordmark {
    font-weight: 700;
    font-size: 15px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-ink);
  }
  @media (max-width: 759px) {
    .mobile-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--color-line);
      background: var(--color-surface-raised);
    }
  }
</style>
