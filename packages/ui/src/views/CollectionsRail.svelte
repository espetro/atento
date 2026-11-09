<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import { collectionMeta } from '../lib/copy'
  import type { UrlState } from '../lib/urlState'
  import { COLLECTION_NAMES, type CollectionName } from '../lib/types'
  import type { Component } from 'svelte'
  import IconInbox from '~icons/lucide/inbox'
  import IconCircleDashed from '~icons/lucide/circle-dashed'
  import IconLock from '~icons/lucide/lock'
  import IconBan from '~icons/lucide/ban'
  import IconCircleX from '~icons/lucide/circle-x'
  import IconEye from '~icons/lucide/eye'
  import IconCheck from '~icons/lucide/check'
  import IconCircle from '~icons/lucide/circle'
  import IconChevronDown from '~icons/lucide/chevron-down'
  import IconChevronRight from '~icons/lucide/chevron-right'
  import IconEllipsis from '~icons/lucide/ellipsis'
  import IconSettings from '~icons/lucide/settings'
  import IconPlay from '~icons/lucide/play'
  import IconPlus from '~icons/lucide/plus'
  import { m } from '../paraglide/messages.js'

  let {
    url,
    setUrl,
    open,
    onClose,
  }: {
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    /** Mobile sheet mode: rendered as an overlay drawer. */
    open?: boolean
    onClose?: () => void
  } = $props()

  const queryClient = useQueryClient()

  const summaryQuery = createQuery(() => ({
    queryKey: ['collections-summary'],
    queryFn: () => api.collectionsSummary(),
    staleTime: 10_000,
  }))
  const summary = $derived(summaryQuery.data ?? null)

  // Host histogram is a full table scan server-side — cache it 30s.
  const pipelineQuery = createQuery(() => ({
    queryKey: ['pipeline'],
    queryFn: () => api.pipeline(),
    staleTime: 30_000,
  }))
  const hosts = $derived.by(() => {
    const list = pipelineQuery.data?.byHost ?? []
    return [...list].sort((a, b) => b.total - a.total || a.host.localeCompare(b.host))
  })
  let hostsExpanded = $state(false)
  const VISIBLE_HOSTS = 5
  const shownHosts = $derived(hostsExpanded ? hosts : hosts.slice(0, VISIBLE_HOSTS))

  const loginHosts = $derived(new Map((summary?.needsLoginHosts ?? []).map((h) => [h.host, h.count])))

  const COLLECTION_ICONS: Record<string, Component> = {
    enriched: IconInbox,
    pending: IconCircleDashed,
    needs_login: IconLock,
    blocked: IconBan,
    errored: IconCircleX,
    review: IconEye,
    triaged: IconCheck,
  }

  let collapsed = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem('linkinbox.railCollapsed') === '1',
  )
  function toggleCollapsed() {
    collapsed = !collapsed
    try {
      localStorage.setItem('linkinbox.railCollapsed', collapsed ? '1' : '0')
    } catch {
      /* private mode */
    }
  }

  function go(view: Partial<UrlState>) {
    setUrl(view)
    onClose?.()
  }

  const ATTENTION = new Set(['needs_login', 'blocked', 'errored', 'review'])

  function selectCollection(name: CollectionName) {
    // Attention collections open the attention surface (remediation copy +
    // per-host login commands); the rest stay in the triage workspace.
    go({
      view: ATTENTION.has(name) ? 'attention' : 'triage',
      collection: name,
      selected: null,
      host: '',
      q: '',
      state: '',
      category: '',
      stale: false,
    })
  }

  function selectHost(host: string) {
    // Host filter applies within the current collection.
    go({ host: url.host === host ? '' : host, selected: null })
  }

  // ---- saved filters (localStorage v1) --------------------------------------

  interface SavedFilter {
    name: string
    collection: string
    q: string
    state: string
    category: string
    host: string
    stale: boolean
  }

  const FILTERS_KEY = 'linkinbox.savedFilters'
  let savedFilters = $state<SavedFilter[]>(readSaved())
  let savingName = $state('')
  let showSave = $state(false)

  function readSaved(): SavedFilter[] {
    try {
      const raw = localStorage.getItem(FILTERS_KEY)
      const parsed = raw ? (JSON.parse(raw) as SavedFilter[]) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  function writeSaved(list: SavedFilter[]) {
    savedFilters = list
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(list))
    } catch {
      /* private mode */
    }
  }

  // The default collection alone is not a "filter" — don't offer to save it.
  const filtersActive = $derived(
    (url.collection !== '' && url.collection !== 'enriched') ||
      url.q !== '' ||
      url.state !== '' ||
      url.category !== '' ||
      url.host !== '' ||
      url.stale,
  )

  function filterLabel(f: SavedFilter): string {
    const bits: string[] = []
    if (f.q) bits.push(`“${f.q.length > 14 ? f.q.slice(0, 14) + '…' : f.q}”`)
    if (f.category) bits.push(f.category)
    if (f.state) bits.push(f.state.replace(/_/g, ' '))
    if (f.host) bits.push(f.host)
    if (f.stale) bits.push(m.saved_filter_stale())
    return bits.length > 0 ? bits.join(' ') : m.saved_filter_all()
  }

  function applyFilter(f: SavedFilter) {
    // Preserve the current surface — a saved filter applies wherever the
    // rail is visible (triage list or attention collections).
    go({
      view: url.view,
      collection: f.collection,
      q: f.q,
      state: f.state,
      category: f.category,
      host: f.host,
      stale: f.stale,
      selected: null,
    })
  }

  function saveCurrent() {
    const name = savingName.trim()
    if (name === '') return
    const f: SavedFilter = {
      name,
      collection: url.collection === 'enriched' ? '' : url.collection,
      q: url.q,
      state: url.state,
      category: url.category,
      host: url.host,
      stale: url.stale,
    }
    writeSaved([...savedFilters.filter((s) => s.name !== name), f])
    savingName = ''
    showSave = false
  }

  function deleteFilter(name: string) {
    writeSaved(savedFilters.filter((s) => s.name !== name))
    if (renaming === name) renaming = null
    if (menuFor === name) menuFor = null
  }

  // ---- rename + context menu -------------------------------------------------
  let renaming = $state<string | null>(null)
  let renameValue = $state('')
  let menuFor = $state<string | null>(null)
  let menuPos = $state({ x: 0, y: 0 })

  function openMenu(e: MouseEvent, name: string) {
    e.preventDefault()
    menuPos = { x: e.clientX, y: e.clientY }
    menuFor = name
  }

  function startRename(name: string) {
    renaming = name
    renameValue = name
    menuFor = null
  }

  $effect(() => {
    if (menuFor == null) return
    const close = () => (menuFor = null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  })

  function commitRename() {
    const name = renaming
    const next = renameValue.trim()
    renaming = null
    if (name == null || next === '' || next === name) return
    if (savedFilters.some((f) => f.name === next)) return
    writeSaved(savedFilters.map((f) => (f.name === name ? { ...f, name: next } : f)))
  }

  // Refresh counts when the window regains focus (SSE also invalidates).
  $effect(() => {
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: ['collections-summary'] })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  })
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sheet-overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose?.()}>
    <nav class="rail sheet" aria-label={m.rail_aria_label()} data-testid="collections-rail">
      {@render railBody()}
    </nav>
  </div>
{:else if !collapsed}
  <nav class="rail" aria-label={m.rail_aria_label()} data-testid="collections-rail">
    {@render railBody()}
  </nav>
{:else}
  <nav class="rail rail-collapsed" aria-label={m.rail_aria_label()} data-testid="collections-rail">
    {@render railBody()}
  </nav>
{/if}

{#snippet railBody()}
  <header class="rail-head">
    {#if !collapsed}
      <button
        type="button"
        class="wordmark"
        onclick={() => selectCollection('enriched')}
        data-testid="wordmark"
      >
        {m.app_name()}
      </button>
    {:else}
      <button
        type="button"
        class="wordmark-icon"
        title={m.wordmark_title()}
        aria-label={m.wordmark_aria()}
        onclick={() => selectCollection('enriched')}
      >
        l
      </button>
    {/if}
    <button
      type="button"
      class="btn btn-ghost btn-icon rail-collapse"
      onclick={toggleCollapsed}
      aria-label={collapsed ? m.aria_expand_collections() : m.aria_collapse_collections()}
      title={collapsed ? m.collapsed_expand() : m.collapsed_collapse()}
    >
      {collapsed ? '»' : '«'}
    </button>
  </header>

  <div class="rail-scroll scroll-thin">
    <div class="rail-group">{m.rail_group_collections()}</div>
    {#each COLLECTION_NAMES as name (name)}
      {@const count = summary?.collections?.[name] ?? 0}
      {@const meta = collectionMeta(name)}
      {@const ColIcon = COLLECTION_ICONS[name] ?? IconCircle}
      <button
        type="button"
        class="rail-row"
        class:is-selected={(url.view === 'triage' || url.view === 'attention') && (url.collection || (url.view === 'attention' ? 'needs_login' : 'enriched')) === name}
        title={collapsed ? `${meta.label} — ${count}` : undefined}
        aria-label={collapsed ? `${meta.label}, ${count}` : undefined}
        onclick={() => selectCollection(name)}
        data-testid="collection-{name}"
      >
        {#if !collapsed}
          <span class="rail-glyph" aria-hidden="true"><ColIcon /></span>
          <span class="rail-label">{meta.label}</span>
          <span class="chip chip-state-{meta.tone} rail-chip"><span class="dot"></span></span>
          <span class="count">{count}</span>
        {:else}
          <span class="rail-icon" aria-hidden="true"><ColIcon /></span>
          {#if count > 0 && name !== 'enriched'}<span class="count-mini">{count}</span>{/if}
        {/if}
      </button>
    {/each}

    {#if !collapsed}
      <div class="rail-group">
        <button type="button" class="group-toggle" onclick={() => (hostsExpanded = !hostsExpanded)}>
          {m.rail_group_hosts()} {#if hostsExpanded}<IconChevronDown />{:else}<IconChevronRight />{/if}
        </button>
      </div>
      {#each shownHosts as h (h.host)}
        {@const loginCount = loginHosts.get(h.host)}
        <button
          type="button"
          class="rail-row"
          class:is-selected={url.host === h.host}
          onclick={() => selectHost(h.host)}
          title={loginCount ? m.host_needs_login_title({ host: h.host, count: loginCount }) : h.host}
        >
          <span class="rail-label rail-host">{h.host}</span>
          {#if loginCount}<span class="chip chip-state-needs-login rail-chip"><span class="dot"></span>{loginCount}</span>{/if}
          <span class="count">{h.total}</span>
        </button>
      {/each}
      {#if hosts.length > VISIBLE_HOSTS && !hostsExpanded}
        <button type="button" class="rail-more" onclick={() => (hostsExpanded = true)}>
          {m.rail_show_more({ count: hosts.length - VISIBLE_HOSTS })}
        </button>
      {/if}

      {#if savedFilters.length > 0}
        <div class="rail-group">{m.rail_group_saved_filters()}</div>
        {#each savedFilters as f (f.name)}
          <div
            class="rail-row saved-row"
            role="group"
            aria-label={m.saved_filter_aria({ name: f.name })}
            oncontextmenu={(e) => openMenu(e, f.name)}
          >
            {#if renaming === f.name}
              <input
                class="input save-input"
                bind:value={renameValue}
                aria-label={m.saved_filter_rename_input()}
                onkeydown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') renaming = null
                }}
                onblur={commitRename}
              />
            {:else}
              <button type="button" class="saved-apply" onclick={() => applyFilter(f)}>
                <span class="rail-label">⌁ {f.name}</span>
                <span class="meta-faint saved-sub">{filterLabel(f)}</span>
              </button>
            {/if}
            <button
              type="button"
              class="saved-delete"
              aria-label={m.saved_filter_options_aria({ name: f.name })}
              aria-haspopup="menu"
              onclick={(e) => {
                e.stopPropagation()
                menuPos = { x: e.clientX, y: e.clientY }
                menuFor = menuFor === f.name ? null : f.name
              }}
            ><IconEllipsis /></button>
          </div>
        {/each}
        {#if menuFor}
          <div
            class="filter-menu"
            role="menu"
            style:left={`${menuPos.x}px`}
            style:top={`${menuPos.y}px`}
          >
            <button type="button" role="menuitem" onclick={() => startRename(menuFor!)}>{m.saved_filter_rename()}</button>
            <button type="button" role="menuitem" onclick={() => deleteFilter(menuFor!)}>{m.saved_filter_delete()}</button>
          </div>
        {/if}
      {/if}

      {#if filtersActive}
        {#if showSave}
          <div class="save-filter">
            <input
              class="input save-input"
              placeholder={m.saved_filter_name_placeholder()}
              bind:value={savingName}
              onkeydown={(e) => e.key === 'Enter' && saveCurrent()}
            />
            <button type="button" class="btn btn-sm btn-primary" onclick={saveCurrent}>{m.saved_filter_save()}</button>
          </div>
        {:else}
          <button type="button" class="rail-more" onclick={() => (showSave = true)}>
            {m.saved_filter_save_current()}
          </button>
        {/if}
      {/if}
    {/if}
  </div>

  <footer class="rail-foot">
    {#if !collapsed}
      <button type="button" class="rail-row" onclick={() => go({ view: 'settings', selected: null })} data-testid="nav-settings">
        <span class="rail-glyph" aria-hidden="true"><IconSettings /></span>
        <span class="rail-label">{m.nav_settings()}</span>
      </button>
      <button type="button" class="rail-row" onclick={() => go({ view: 'run', selected: null })} data-testid="nav-run">
        <span class="rail-glyph" aria-hidden="true"><IconPlay /></span>
        <span class="rail-label">{m.nav_run()}</span>
      </button>
      <button type="button" class="rail-row" onclick={() => go({ dialog: 'ingest' })} data-testid="nav-ingest">
        <span class="rail-glyph" aria-hidden="true"><IconPlus /></span>
        <span class="rail-label">{m.nav_ingest()}</span>
      </button>
    {:else}
      <button type="button" class="rail-row" title={m.nav_settings()} aria-label={m.nav_settings()} onclick={() => go({ view: 'settings', selected: null })}><IconSettings /></button>
      <button type="button" class="rail-row" title={m.nav_run()} aria-label={m.nav_run()} onclick={() => go({ view: 'run', selected: null })}><IconPlay /></button>
      <button type="button" class="rail-row" title={m.nav_ingest()} aria-label={m.nav_ingest()} onclick={() => go({ dialog: 'ingest' })}><IconPlus /></button>
    {/if}
  </footer>
{/snippet}

<style>
  .rail {
    width: 232px;
    flex: none;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--color-surface);
    border-right: 1px solid var(--color-line);
  }
  .rail-collapsed {
    width: 56px;
  }
  /* Icon-only rows center their glyph (Linear/Raycast-style collapsed rail). */
  .rail-collapsed .rail-row {
    justify-content: center;
    padding-inline: 0;
  }
  /* Group headers ("collections", "hosts") don't fit a 56px rail. */
  .rail-collapsed .rail-group {
    display: none;
  }
  .rail-icon,
  .rail-glyph {
    font-size: 15px;
    line-height: 1;
  }
  .rail-icon :global(svg),
  .rail-glyph :global(svg) {
    display: block;
    margin: 0 auto;
  }
  .rail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 8px 6px;
    gap: 4px;
  }
  .wordmark {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--color-ink);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 6px;
  }
  .wordmark-icon {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px;
    margin: 0 auto;
  }
  .rail-collapse {
    font-size: 13px;
  }
  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 6px;
  }
  .rail-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rail-chip {
    flex: none;
    padding: 0 6px;
  }
  .rail-host {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .rail-icon,
  .rail-glyph {
    width: 20px;
    text-align: center;
    flex: none;
  }
  .count-mini {
    margin-left: auto;
    font-size: 10px;
    color: var(--color-ink-faint);
  }
  .group-toggle {
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
    color: inherit;
    padding: 0;
  }
  .rail-more {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-ink-soft);
    font-size: 12px;
    padding: 5px 10px;
  }
  .rail-more:hover {
    color: var(--color-ink);
  }
  .saved-row {
    display: flex;
    align-items: center;
    padding: 0;
  }
  .saved-apply {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-ink);
    font-size: 13px;
    padding: 7px 10px;
    text-align: left;
  }
  .saved-sub {
    font-size: 10.5px;
  }
  .saved-delete {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-ink-faint);
    font-size: 11px;
    padding: 6px 8px 6px 0;
  }
  .saved-delete:hover {
    color: var(--color-state-blocked);
  }
  .filter-menu {
    position: fixed;
    z-index: 60;
    display: flex;
    flex-direction: column;
    min-width: 96px;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid var(--color-line);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-pop, 0 8px 24px rgba(0, 0, 0, 0.12));
  }
  .filter-menu button {
    text-align: left;
    padding: 6px 10px;
    font-size: 12.5px;
    border-radius: 6px;
    background: none;
    color: var(--color-ink);
    cursor: pointer;
  }
  .filter-menu button:hover {
    background: var(--color-surface-sunken, rgba(0, 0, 0, 0.04));
  }
  .save-filter {
    display: flex;
    gap: 6px;
    padding: 6px 10px;
  }
  .save-input {
    padding: 4px 8px;
    font-size: 12px;
  }
  .rail-foot {
    border-top: 1px solid var(--color-line);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sheet-overlay {
    position: fixed;
    inset: 0;
    background: rgb(26 26 26 / 0.35);
    z-index: 40;
    display: flex;
  }
  .sheet {
    width: 260px;
    box-shadow: var(--shadow-pop);
    animation: rise 200ms cubic-bezier(0.19, 1, 0.22, 1);
  }
  @keyframes rise {
    from {
      transform: translateX(-16px);
      opacity: 0;
    }
  }
  @media (max-width: 759px) {
    .rail {
      display: none;
    }
    /* The mobile sheet keeps the rail visible inside its overlay. */
    .sheet-overlay .rail {
      display: flex;
    }
  }
  @media (min-width: 760px) and (max-width: 1099px) {
    .rail {
      width: 56px;
    }
    .rail .rail-row {
      justify-content: center;
      padding-inline: 0;
    }
    .rail .rail-glyph,
    .rail .rail-icon {
      font-size: 15px;
      line-height: 1;
    }
    .rail .rail-glyph :global(svg),
    .rail .rail-icon :global(svg) {
      display: block;
      margin: 0 auto;
    }
    .rail .rail-label,
    .rail .count,
    .rail .rail-chip,
    .rail .rail-scroll > .rail-group,
    .rail .rail-foot .rail-label,
    .rail .saved-row,
    .rail .rail-more,
    .rail .save-filter {
      display: none;
    }
    .rail .rail-glyph {
      display: inline-block;
    }
    .rail .rail-row:has(.rail-host) {
      display: none;
    }
    .rail .wordmark {
      display: none;
    }
    .rail-head {
      flex-direction: column;
      padding-top: 12px;
    }
  }
</style>
