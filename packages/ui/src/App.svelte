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
  import CommandPalette from './components/CommandPalette.svelte'
  import AssistantDrawer from './components/AssistantDrawer.svelte'
  import { acpAvailable, startLayoutToolServer } from './lib/acp'
  import { PaneGroup, Pane, PaneResizer } from 'paneforge'
  import IconMenu from '~icons/lucide/menu'
  import IconSettings from '~icons/lucide/settings'
  import IconPlus from '~icons/lucide/plus'
  import LiveSync from './components/LiveSync.svelte'
  import { sseConnected } from './lib/events'
  import { m } from './paraglide/messages.js'

  const queryClient = createQueryClient()

  let url = $state<UrlState>(parseUrlState(new URLSearchParams(window.location.search)))
  let sheetOpen = $state(false)
  let paletteOpen = $state(false)
  let assistantOpen = $state(false)
  // ACP assistant: only when the shell bridge exposes /acp (never on web).
  let assistantAvailable = $state(false)

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
    // ⌘K/⌃K toggles the command palette; the single-key dispatcher skips
    // modifier chords, so this listens on window directly.
    const onPaletteKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        paletteOpen = !paletteOpen
      }
    }
    window.addEventListener('keydown', onPaletteKey)
    // ⌘J toggles the assistant drawer (desktop shell only).
    const onAssistantKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (assistantAvailable) assistantOpen = !assistantOpen
      }
    }
    window.addEventListener('keydown', onAssistantKey)
    // ui-layout MCP tool calls round-trip through here (gen/catalog is the
    // source of truth and lives in the page).
    const offLayoutServer = startLayoutToolServer()
    void acpAvailable().then((ok) => (assistantAvailable = ok))
    return () => {
      window.removeEventListener('keydown', onAssistantKey)
      offLayoutServer()
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onPaletteKey)
      offKeymap()
    }
  })
</script>

<QueryClientProvider client={queryClient}>
  <LiveSync />
  <div class="app-shell" data-testid="app-shell">
    <!-- Persistent rail: every view renders rail + content (A1). -->
    <CollectionsRail {url} {setUrl} />
    <PaneGroup direction="horizontal" autoSaveId="linkinbox:shell" class="shell-panes">
    <Pane class="app-col">
      <header class="mobile-bar">
        <button
          type="button"
          class="btn btn-ghost btn-icon"
          aria-label={m.aria_open_collections()}
          onclick={() => (sheetOpen = true)}
          data-testid="rail-toggle"
        >
          <IconMenu />
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
        <button type="button" class="btn btn-ghost btn-sm" aria-label={m.nav_settings()} onclick={() => setUrl({ view: 'settings', selected: null })}><IconSettings /></button>
        <button type="button" class="btn btn-sm btn-primary" aria-label={m.nav_ingest()} onclick={() => setUrl({ dialog: 'ingest' })} data-testid="mobile-ingest"><IconPlus /></button>
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
    </Pane>
    {#if assistantOpen && assistantAvailable}
      <PaneResizer class="pane-resizer" />
      <Pane defaultSize={26} minSize={16} maxSize={45} class="assistant-pane" data-testid="assistant-pane">
        <AssistantDrawer onClose={() => (assistantOpen = false)} />
      </Pane>
    {/if}
    </PaneGroup>
    {#if sheetOpen}
      <CollectionsRail {url} {setUrl} open={true} onClose={() => (sheetOpen = false)} />
    {/if}
    {#if url.dialog === 'ingest'}
      <IngestDialog open={true} {setUrl} />
    {/if}
    <CommandPalette
      open={paletteOpen}
      {url}
      {setUrl}
      invalidate={() => queryClient.invalidateQueries()}
      openAssistant={assistantAvailable ? () => (assistantOpen = true) : undefined}
      onClose={() => (paletteOpen = false)}
    />
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
  .app-shell :global(.shell-panes) {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
  }
  :global(.app-col) {
    flex: 1;
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .app-shell :global(.assistant-pane) {
    height: 100%;
    min-height: 0;
    min-width: 0;
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
