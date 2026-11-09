<script lang="ts">
  import { onMount } from 'svelte'
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import { createQueryClient } from './lib/api'
  import { parseUrlState, toUrlState, effectiveCollection, type UrlState } from './lib/urlState'
  import { startKeyboard, onShortcut } from './lib/keyboard'
  import Triage from './views/Triage.svelte'
  import Attention from './views/Attention.svelte'
  import RunStatus from './views/RunStatus.svelte'
  import Settings from './views/Settings.svelte'
  import Metrics from './views/Metrics.svelte'
  import IngestDialog from './views/IngestDialog.svelte'
  import Dialog from './lib/components/Dialog.svelte'
  import CommandPalette from './lib/components/CommandPalette.svelte'
  import AssistantDrawer from './lib/components/AssistantDrawer.svelte'
  import AppSidebar from './lib/components/AppSidebar.svelte'
  import { acpAvailable, startLayoutToolServer } from './lib/acp'
  import * as Sidebar from '$lib/components/ui/sidebar/index.js'
  import * as Resizable from '$lib/components/ui/resizable/index.js'
  import IconPlus from '~icons/lucide/plus'
  import IconSearch from '~icons/lucide/search'
  import LiveSync from './lib/components/LiveSync.svelte'
  import { sseConnected } from './lib/events'
  import { m } from './paraglide/messages.js'

  const queryClient = createQueryClient()

  let url = $state<UrlState>(parseUrlState(new URLSearchParams(window.location.search)))
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
    const onPaletteEvt = () => (paletteOpen = true)
    window.addEventListener('linkinbox:palette', onPaletteEvt)
    // ⌘J toggles the assistant pane (desktop shell only).
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
      window.removeEventListener('linkinbox:palette', onPaletteEvt)
      offLayoutServer()
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onPaletteKey)
      offKeymap()
    }
  })
</script>

<QueryClientProvider client={queryClient}>
  <LiveSync />
  <Sidebar.Provider class="app-shell" data-testid="app-shell">
    <AppSidebar {url} {setUrl} onIngest={() => setUrl({ dialog: 'ingest' })} />
    <Sidebar.Inset>
      <header class="topbar" data-testid="topbar">
        <Sidebar.Trigger data-testid="rail-toggle" />
        <span class="topbar-crumb">
          {#if url.view === 'triage'}
            <span class="dot" style={`background: ${collectionDot(effectiveCollection(url))};`}></span>
            <span class="topbar-title display">{collectionMeta(effectiveCollection(url)).label}</span>
          {/if}
        </span>
        <button
          type="button"
          class="search-pill"
          onclick={() => (paletteOpen = true)}
          data-testid="topbar-palette"
        >
          <IconSearch />
          <span class="search-pill-label">{m.search_placeholder()}</span>
          <kbd class="kbd">⌘K</kbd>
        </button>
        <button
          type="button"
          class="btn btn-sm btn-primary btn-pill"
          onclick={() => setUrl({ dialog: 'ingest' })}
          data-testid="mobile-ingest"
        >
          <IconPlus /> {m.nav_ingest()}
        </button>
      </header>
      <Resizable.PaneGroup direction="horizontal" autoSaveId="linkinbox:shell" class="shell-panes">
        <Resizable.Pane class="app-col">
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
        </Resizable.Pane>
        {#if assistantOpen && assistantAvailable}
          <Resizable.Handle withHandle />
          <Resizable.Pane defaultSize={26} minSize={16} maxSize={45} class="assistant-pane" data-testid="assistant-pane">
            <AssistantDrawer onClose={() => (assistantOpen = false)} />
          </Resizable.Pane>
        {/if}
      </Resizable.PaneGroup>
    </Sidebar.Inset>
  </Sidebar.Provider>

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

<script lang="ts" module>
  import { collectionMeta } from './lib/copy'
  const COLLECTION_DOTS: Record<string, string> = {
    enriched: 'var(--color-state-enriched)',
    pending: 'var(--color-state-pending)',
    needs_login: 'var(--color-state-needs-login)',
    blocked: 'var(--color-state-blocked)',
    errored: 'var(--color-state-errored)',
    review: 'var(--color-state-review)',
    triaged: 'var(--color-state-triaged)',
  }
  function collectionDot(name: string): string {
    return COLLECTION_DOTS[name] ?? 'var(--color-ink-faint)'
  }
</script>

<style>
  :global(.app-shell) {
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }
  /* Quiet.md-style chrome: trigger left, breadcrumb left-of-center,
     pill search centered, pill action right. Hairline divider only. */
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--color-line);
    flex: none;
  }
  .topbar-crumb {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .topbar-title {
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-pill {
    flex: 1;
    max-width: 340px;
    margin-inline: auto;
  }
  .search-pill-label {
    flex: 1;
    text-align: left;
  }
  :global(.shell-panes) {
    flex: 1;
    min-height: 0;
    height: 100%;
  }
  :global(.app-col) {
    flex: 1;
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  :global(.assistant-pane) {
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
