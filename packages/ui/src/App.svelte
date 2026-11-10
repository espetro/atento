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
  import IconSearch from '~icons/lucide/search'
  import IconSettings from '~icons/lucide/settings'
  import IconListFilter from '~icons/lucide/list-filter'
  import FilterMenu from './lib/components/FilterMenu.svelte'
  import LiveSync from './lib/components/LiveSync.svelte'
  import { sseConnected } from './lib/events'
  import { initTheme } from './lib/prefs'
  import { m } from './paraglide/messages.js'

  const queryClient = createQueryClient()

  let url = $state<UrlState>(parseUrlState(new URLSearchParams(window.location.search)))
  let paletteOpen = $state(false)
  let agentOpen = $state(false)
  let qInput = $state('')
  $effect(() => { if (url.q !== qInput) qInput = url.q })
  let searchEl = $state<HTMLInputElement | null>(null)
  let filterOpen = $state(false)
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  function onSearchInput() {
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => setUrl({ q: qInput }), 220)
  }
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
    const onFocusSearch = () => { searchEl?.focus(); searchEl?.select() }
    window.addEventListener('linkinbox:focus-search', onFocusSearch)
    // ⌘J toggles the agent panel (desktop shell only).
    const onAssistantKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (assistantAvailable) agentOpen = !agentOpen
      }
    }
    window.addEventListener('keydown', onAssistantKey)
    // ui-layout MCP tool calls round-trip through here (gen/catalog is the
    // source of truth and lives in the page).
    const offTheme = initTheme()
    const offLayoutServer = startLayoutToolServer()
    // Persist window bounds so the next launch restores last size (B-shell).
    let boundsTimer: ReturnType<typeof setTimeout> | null = null
    const postBounds = () => {
      const bridge = (window as unknown as { __linkinboxBridge?: string }).__linkinboxBridge
      if (bridge === undefined) return
      if (boundsTimer !== null) clearTimeout(boundsTimer)
      boundsTimer = setTimeout(() => {
        void fetch(`${bridge}/window-bounds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ w: window.innerWidth, h: window.innerHeight, x: window.screenX, y: window.screenY }),
        }).catch(() => {})
      }, 400)
    }
    window.addEventListener('resize', postBounds)
    postBounds()
    void acpAvailable().then((ok) => (assistantAvailable = ok))
    return () => {
      window.removeEventListener('keydown', onAssistantKey)
      window.removeEventListener('linkinbox:palette', onPaletteEvt)
      window.removeEventListener('linkinbox:focus-search', onFocusSearch)
      offTheme()
      window.removeEventListener('resize', postBounds)
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
      <main class="app-main">
        <header class="topbar" data-testid="topbar">
          <Sidebar.Trigger aria-label={m.aria_open_collections()} data-testid="rail-toggle" />
          <span class="topbar-right">
            <input
              bind:this={searchEl}
              class="input search-input-pill topbar-search"
              type="search"
              placeholder={m.search_placeholder()}
              aria-label={m.search_aria()}
              data-testid="search-input"
              bind:value={qInput}
              oninput={onSearchInput}
            />
            <span class="filter-anchor">
              <button
                type="button"
                class="topbar-btn"
                aria-haspopup="dialog"
                aria-expanded={filterOpen}
                aria-label={m.filter_button()}
                onclick={() => (filterOpen = !filterOpen)}
                data-testid="filter-button"
              >
                <IconListFilter />
              </button>
              {#if filterOpen}
                <FilterMenu {url} {setUrl} />
              {/if}
            </span>
            <button type="button" class="topbar-btn" aria-label={m.nav_settings()} onclick={() => setUrl({ view: 'settings', selected: null })} data-testid="topbar-settings">
              <IconSettings />
            </button>
          </span>
        </header>
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
    openAssistant={assistantAvailable ? () => (agentOpen = true) : undefined}
    onClose={() => (paletteOpen = false)}
  />

  {#if assistantAvailable}
    {#if agentOpen}
      <Dialog open={true} labelledBy="agent-title" onClose={() => (agentOpen = false)}>
        <div class="agent-dialog" data-testid="assistant-pane">
          <AssistantDrawer onClose={() => (agentOpen = false)} />
        </div>
      </Dialog>
    {/if}
    <button
      type="button"
      class="agent-dock"
      aria-label={m.assistant_title()}
      aria-expanded={agentOpen}
      onclick={() => (agentOpen = !agentOpen)}
      data-testid="agent-fab"
    >
      <IconSparkles />
      <span>Agent</span>
    </button>
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
  :global([data-slot='sidebar-inset']) {
    background: var(--color-surface);
  }
  .app-main {
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: auto;
    margin: 4px 8px 8px 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgb(22 24 29 / 0.04);
  }
  @media (max-width: 767px) {
    .app-main {
      margin: 0;
      border: none;
      border-radius: 0;
    }
  }
  /* Icon-only sticky topbar (Notion/ElevenLabs): transparent, chrome is
     glyphs only — logotype + sidebar toggle left, search + settings right. */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 12px;
    flex: none;
  }
  .topbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--color-ink-soft);
    cursor: pointer;
    transition:
      background-color 140ms var(--ease-out-expo),
      color 140ms var(--ease-out-expo);
  }
  .topbar-btn:hover {
    background: var(--color-accent);
    color: var(--color-ink);
  }
  .topbar-right {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  /* Agent dock: icon+title pill pinned inside the content card's corner
     (Linear reference) → opens the agent dialog. */
  .agent-dock {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 65;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 13px;
    border-radius: 999px;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line-strong);
    color: var(--color-ink);
    font-size: 12.5px;
    font-weight: 500;
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    transition:
      transform 180ms var(--ease-out-expo),
      background-color 140ms var(--ease-out-expo);
  }
  .agent-dock:hover {
    background: var(--color-surface-sunken);
    transform: translateY(-1px);
  }
  .agent-dock:active {
    transform: scale(0.97);
  }
  .agent-dock[aria-expanded='true'] {
    background: var(--color-ink);
    border-color: var(--color-ink);
    color: var(--color-surface);
  }
  .agent-dialog {
    width: min(560px, calc(100vw - 48px));
    height: min(620px, calc(100dvh - 120px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    margin: -10px;
  }
  .topbar-search {
    width: 220px;
    font-size: 12.5px;
  }
  .filter-anchor {
    position: relative;
    display: inline-flex;
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
