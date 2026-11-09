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
  import Dialog from './lib/components/Dialog.svelte'
  import CommandPalette from './lib/components/CommandPalette.svelte'
  import AssistantDrawer from './lib/components/AssistantDrawer.svelte'
  import AppSidebar from './lib/components/AppSidebar.svelte'
  import { acpAvailable, startLayoutToolServer } from './lib/acp'
  import * as Sidebar from '$lib/components/ui/sidebar/index.js'
  import IconSparkles from '~icons/lucide/sparkles'
  import IconPanelLeft from '~icons/lucide/panel-left'
  import LiveSync from './lib/components/LiveSync.svelte'
  import { sseConnected } from './lib/events'
  import { initTheme } from './lib/prefs'
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
    // ⌘J toggles the agent panel (desktop shell only).
    const onAssistantKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (assistantAvailable) assistantOpen = !assistantOpen
      }
    }
    window.addEventListener('keydown', onAssistantKey)
    // ui-layout MCP tool calls round-trip through here (gen/catalog is the
    // source of truth and lives in the page).
    const offTheme = initTheme()
    const offLayoutServer = startLayoutToolServer()
    void acpAvailable().then((ok) => (assistantAvailable = ok))
    return () => {
      window.removeEventListener('keydown', onAssistantKey)
      window.removeEventListener('linkinbox:palette', onPaletteEvt)
      offTheme()
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
      <!-- Mobile: the sidebar is a Sheet; this floating trigger opens it. -->
      <Sidebar.Trigger class="mobile-trigger" aria-label={m.aria_open_collections()} data-testid="rail-toggle"><IconPanelLeft /></Sidebar.Trigger>
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

  {#if assistantAvailable}
    <button
      type="button"
      class="agent-fab"
      aria-label={m.assistant_title()}
      aria-expanded={assistantOpen}
      onclick={() => (assistantOpen = !assistantOpen)}
      data-testid="agent-fab"
    >
      <IconSparkles />
    </button>
    {#if assistantOpen}
      <div class="assistant-pop" data-testid="assistant-pane">
        <AssistantDrawer onClose={() => (assistantOpen = false)} />
      </div>
    {/if}
  {/if}

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

<style>
  :global(.app-shell) {
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }
  .app-main {
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* Mobile-only sidebar opener — the sidebar is a Sheet under 768px. */
  :global(.mobile-trigger) {
    display: none;
  }
  @media (max-width: 767px) {
    :global(.mobile-trigger) {
      display: inline-flex;
      position: fixed;
      top: 10px;
      left: 10px;
      z-index: 40;
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: var(--color-surface-raised);
      border: 1px solid var(--color-line);
      box-shadow: var(--shadow-pop);
      color: var(--color-ink-soft);
      align-items: center;
      justify-content: center;
    }
  }
  /* Notion-style agent: FAB bottom-right → floating chat panel. */
  .agent-fab {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 65;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line-strong);
    color: var(--color-accent-blue);
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    transition:
      transform 180ms var(--ease-out-expo),
      box-shadow 180ms var(--ease-out-expo);
  }
  .agent-fab:hover {
    transform: translateY(-2px) scale(1.04);
  }
  .agent-fab:active {
    transform: scale(0.95);
  }
  .agent-fab[aria-expanded='true'] {
    background: var(--color-accent-blue);
    border-color: var(--color-accent-blue);
    color: var(--color-accent-ink);
  }
  .assistant-pop {
    position: fixed;
    right: 20px;
    bottom: 76px;
    z-index: 64;
    width: min(380px, calc(100vw - 32px));
    height: min(560px, calc(100dvh - 110px));
    display: flex;
    flex-direction: column;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 16px;
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    transform-origin: bottom right;
    animation: pop-in 200ms var(--ease-out-expo);
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: scale(0.94) translateY(8px);
    }
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
