<script lang="ts">
  import { onMount, untrack } from 'svelte'
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
  import { suppressNativePreviews } from './lib/desktop'
  import AgentStatus from './lib/components/AgentStatus.svelte'
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
  // Mirror url.q into the input only when the URL changes (not on every keystroke).
  $effect(() => {
    const q = url.q
    untrack(() => { if (q !== qInput) qInput = q })
  })
  let searchEl = $state<HTMLInputElement | null>(null)
  let filterOpen = $state(false)
  function dismissFilter(e: Event) {
    if (!filterOpen) return
    if (e instanceof KeyboardEvent) {
      if (e.key === 'Escape') filterOpen = false
      return
    }
    if (!(e.target as Element | null)?.closest('.filter-anchor')) filterOpen = false
  }
  // The native preview webview composites above the DOM; hide it while the
  // floating assistant overlaps it.
  $effect(() => {
    if (agentOpen) return suppressNativePreviews()
  })
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  function onSearchInput() {
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => setUrl({ q: qInput }), 220)
  }
  // The palette edits the same `qInput`; commit it to the URL when it changes.
  $effect(() => {
    if (paletteOpen && qInput !== url.q) onSearchInput()
  })
  const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform)
  const paletteHint = isMac ? '⌘K' : 'Ctrl K'
  // ACP assistant: only when the shell bridge exposes /acp (never on web).
  let assistantAvailable = $state(false)

  // Esc in settings returns to the view the user came from.
  let viewBeforeSettings: UrlState['view'] = 'triage'
  function setUrl(next: Partial<UrlState>) {
    if (next.view === 'settings' && url.view !== 'settings') viewBeforeSettings = url.view
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
    // Esc leaves settings unless it is closing a dialog/menu or editing a field
    // (Dialog captures Esc first and stops propagation).
    const onSettingsEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || url.view !== 'settings') return
      if (url.dialog !== '' || paletteOpen || agentOpen) return
      const t = e.target as HTMLElement | null
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) { t.blur(); return }
      setUrl({ view: viewBeforeSettings === 'settings' ? 'triage' : viewBeforeSettings })
    }
    window.addEventListener('keydown', onSettingsEsc)
    const onAgentEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && agentOpen && !e.defaultPrevented) agentOpen = false
    }
    window.addEventListener('keydown', onAgentEsc)
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
    void acpAvailable().then((ok) => (assistantAvailable = ok))
    return () => {
      window.removeEventListener('keydown', onAssistantKey)
      window.removeEventListener('keydown', onSettingsEsc)
      window.removeEventListener('keydown', onAgentEsc)
      window.removeEventListener('linkinbox:palette', onPaletteEvt)
      window.removeEventListener('linkinbox:focus-search', onFocusSearch)
      offTheme()
      offLayoutServer()
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onPaletteKey)
      offKeymap()
    }
  })
</script>

<svelte:window onpointerdown={dismissFilter} onkeydown={dismissFilter} />

<QueryClientProvider client={queryClient}>
  <LiveSync />
  <Sidebar.Provider class="app-shell" data-testid="app-shell">
    <AppSidebar {url} {setUrl} onIngest={() => setUrl({ dialog: 'ingest' })} />
    <Sidebar.Inset>
      <main class="app-main">
        <header class="topbar" data-testid="topbar">
          <Sidebar.Trigger aria-label={m.aria_open_collections()} data-testid="rail-toggle" />
          <span class="topbar-right">
            {#if url.view !== 'settings'}
            <label class="topbar-search-wrap">
              <IconSearch />
              <input
              bind:this={searchEl}
              class="topbar-search"
              type="search"
              placeholder={m.search_title()}
              aria-label={m.search_aria()}
              data-testid="search-input"
              bind:value={qInput}
              oninput={onSearchInput}
              />
              <kbd class="kbd topbar-kbd" aria-hidden="true">{paletteHint}</kbd>
            </label>
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
            {/if}
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
      <div class="dock-row" data-testid="dock-row">
        {#if assistantAvailable}
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
          <AgentStatus />
        {/if}
      </div>
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
    bind:query={qInput}
    openAssistant={assistantAvailable ? () => (agentOpen = true) : undefined}
    onClose={() => (paletteOpen = false)}
  />

  {#if assistantAvailable}
    {#if agentOpen}
      <div class="agent-panel" role="dialog" aria-label={m.assistant_title()} data-testid="assistant-pane">
        <AssistantDrawer onClose={() => (agentOpen = false)} />
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
  /* Level 0: shell plane shared by the sidebar and the dock row. The content
     card (level 1) floats above it. */
  :global([data-slot='sidebar-inset']) {
    background: var(--color-sidebar) !important;
    min-width: 0;
  }
  :global([data-slot='sidebar-inner']) {
    background: var(--color-sidebar);
  }
  :global([data-slot='sidebar-container']) {
    border: 0 !important;
  }
  .dock-row {
    flex: none;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    padding: 0 12px;
  }
  .app-main {
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: auto;
    margin: 8px 8px 0 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgb(22 24 29 / 0.05), 0 8px 24px -12px rgb(22 24 29 / 0.10);
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
  /* Agent CTA: minimal icon+title on the level-0 plane under the card. */
  .agent-dock {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--color-ink-soft);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color 140ms var(--ease-out-expo),
      color 140ms var(--ease-out-expo);
  }
  .agent-dock :global(svg) {
    width: 14px;
    height: 14px;
  }
  .agent-dock:hover,
  .agent-dock[aria-expanded='true'] {
    background: var(--color-sidebar-accent);
    color: var(--color-ink);
  }
  /* Floating assistant: a non-modal card anchored above the dock, bottom
     right, growing out of the Agent button. The page stays interactive. */
  .agent-panel {
    position: fixed;
    right: 16px;
    bottom: 52px;
    width: min(400px, calc(100vw - 32px));
    height: min(560px, calc(100dvh - 120px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-surface-raised);
    border: 1px solid var(--color-line);
    border-radius: 18px;
    box-shadow: var(--shadow-pop);
    transform-origin: bottom right;
    animation: agent-pop 220ms cubic-bezier(0.19, 1, 0.22, 1);
    z-index: 40;
  }
  @keyframes agent-pop {
    from { opacity: 0; transform: translateY(8px) scale(0.92); }
  }
  /* Minimal search: glyph + title, no field chrome; grows on focus. */
  .topbar-search-wrap {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border-radius: 8px;
    color: var(--color-ink-soft);
    cursor: text;
    transition: background-color 140ms var(--ease-out-expo);
  }
  .topbar-search-wrap:hover,
  .topbar-search-wrap:focus-within {
    background: var(--color-accent);
    color: var(--color-ink);
  }
  .topbar-search-wrap :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .topbar-search {
    width: 64px;
    border: none;
    outline: none;
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    transition: width 220ms var(--ease-out-expo);
  }
  .topbar-search::placeholder {
    color: currentColor;
  }
  .topbar-search:focus,
  .topbar-search:not(:placeholder-shown) {
    width: 160px;
  }
  .topbar-kbd {
    margin-left: 2px;
    border-bottom-width: 1px;
    background: transparent;
  }
  .topbar-search::-webkit-search-cancel-button {
    display: none;
  }
  .filter-anchor {
    position: relative;
    display: inline-flex;
  }
  .keymap {
    min-width: 340px;
    padding: 20px 24px 22px;
  }
  .keymap-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 14px;
  }
  .keymap-table {
    border-collapse: collapse;
    font-size: 13px;
  }
  .keymap-table td {
    padding: 6px 22px 6px 0;
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
