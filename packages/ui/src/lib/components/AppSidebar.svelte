<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { api } from '../api'
  import { COLLECTION_NAMES } from '../types'
  import { collectionMeta } from '../copy'
  import { effectiveCollection, type UrlState } from '../urlState'
  import * as Sidebar from '$lib/components/ui/sidebar/index.js'
  import IconInbox from '~icons/lucide/inbox'
  import IconSearch from '~icons/lucide/search'
  import IconLoaderCircle from '~icons/lucide/loader-circle'
  import IconLock from '~icons/lucide/lock'
  import IconBan from '~icons/lucide/ban'
  import IconCircleX from '~icons/lucide/circle-x'
  import IconEye from '~icons/lucide/eye'
  import IconCheck from '~icons/lucide/check'
  import IconSparkles from '~icons/lucide/sparkles'
  import IconCode from '~icons/lucide/code'
  import IconPalette from '~icons/lucide/palette'
  import IconPackage from '~icons/lucide/package'
  import IconShield from '~icons/lucide/shield'
  import IconWrench from '~icons/lucide/wrench'
  import IconBookOpen from '~icons/lucide/book-open'
  import IconTag from '~icons/lucide/tag'
  import IconGlobe from '~icons/lucide/globe'
  import IconPlus from '~icons/lucide/plus'
  import IconFolder from '~icons/lucide/folder'
  import { m } from '../../paraglide/messages.js'
  import type { Component } from 'svelte'

  /**
   * Navigation sidebar (Notion reference): header wordmark + collapse, a
   * Search row that opens ⌘K, then three grouping views — Collections
   * (pipeline states), By site (top hosts), By type (enrichment
   * categories). No footer: app actions live in the palette.
   */
  type Section = 'collections' | 'sites' | 'types' | 'custom'
  let section = $state<Section>('collections')
  interface CustomCollection { name: string; host?: string; category?: string; collection?: string }
  let customs = $state<CustomCollection[]>(loadCustoms())
  function loadCustoms(): CustomCollection[] {
    try { return JSON.parse(localStorage.getItem('linkinbox:collections') ?? '[]') } catch { return [] }
  }
  function saveCustoms() {
    try { localStorage.setItem('linkinbox:collections', JSON.stringify(customs)) } catch { /* private */ }
  }
  let addOpen = $state(false)
  let addName = $state('')
  function addCustom() {
    const name = addName.trim()
    if (name === '') return
    customs = [...customs, { name, collection: 'enriched' }]
    saveCustoms()
    addName = ''
    addOpen = false
  }
  function removeCustom(name: string) {
    customs = customs.filter((c) => c.name !== name)
    saveCustoms()
  }
  function openCustom(c: CustomCollection) {
    setUrl({ view: 'triage', collection: (c.collection ?? 'enriched') as UrlState['collection'], host: c.host ?? '', category: c.category ?? '', selected: null })
  }

  let { url, setUrl, onIngest: _onIngest }: {
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    onIngest?: () => void
  } = $props()

  const summaryQuery = createQuery(() => ({
    queryKey: ['collections-summary'],
    queryFn: () => api.collectionsSummary(),
  }))
  const summary = $derived(summaryQuery.data)

  const pipelineQuery = createQuery(() => ({
    queryKey: ['pipeline'],
    queryFn: () => api.pipeline(),
  }))
  const hosts = $derived((pipelineQuery.data?.byHost ?? []).slice(0, 8))

  // "By type" — category counts over the current collection's visible set.
  const linksQuery = createQuery(() => ({
    queryKey: ['links', 'types'],
    queryFn: () => api.links({ collection: 'enriched', limit: 400 }),
  }))
  const types = $derived.by(() => {
    const counts = new Map<string, number>()
    for (const l of linksQuery.data?.items ?? []) {
      if (l.category) counts.set(l.category, (counts.get(l.category) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  })

  const COLLECTION_ICONS: Record<string, Component> = {
    enriched: IconInbox,
    pending: IconLoaderCircle,
    needs_login: IconLock,
    blocked: IconBan,
    errored: IconCircleX,
    review: IconEye,
    triaged: IconCheck,
  }
  const TYPE_ICONS: Record<string, Component> = {
    ai: IconSparkles,
    engineering: IconCode,
    design: IconPalette,
    product: IconPackage,
    security: IconShield,
    ops: IconWrench,
    reading: IconBookOpen,
  }

  function openCollection(name: string) {
    setUrl({ view: 'triage', collection: name as UrlState['collection'], host: '', category: '', selected: null })
  }
  function openHost(host: string) {
    setUrl({ view: 'triage', collection: '', host, category: '', selected: null })
  }
  function openType(category: string) {
    setUrl({ view: 'triage', collection: 'enriched' as UrlState['collection'], category, host: '', selected: null })
  }
  function hostInitial(host: string): string {
    return (host.replace(/^www\./, '')[0] ?? '·').toUpperCase()
  }
  function hostHue(host: string): number {
    let h = 0
    for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return h % 8
  }
</script>

<Sidebar.Root collapsible="icon" data-testid="app-sidebar">
  <Sidebar.Header>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          size="lg"
          tooltipContent={m.app_name()}
          onclick={() => openCollection('enriched')}
        >
          <IconInbox />
          <span class="display" style="font-size: 16px;">{m.app_name()}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          tooltipContent={`${m.palette_title()} ⌘K`}
          onclick={() => window.dispatchEvent(new CustomEvent('linkinbox:palette'))}
          data-testid="sidebar-search"
        >
          <IconSearch />
          <span>{m.search_placeholder()}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Header>

  <div class="sidebar-chips" data-testid="sidebar-chips">
    {#each ([['collections', IconInbox, m.rail_group_collections()], ['sites', IconGlobe, m.rail_group_sites()], ['types', IconTag, m.rail_group_types()]] as const) as [id, ChipIcon, label] (id)}
      <button
        type="button"
        class="sidebar-chip"
        class:is-active={section === id}
        onclick={() => (section = id)}
        data-testid={`chip-${id}`}
      >
        <ChipIcon />
        <span>{label}</span>
      </button>
    {/each}
    <button
      type="button"
      class="sidebar-chip"
      class:is-active={section === 'custom' || addOpen}
      onclick={() => { section = 'custom'; addOpen = !addOpen }}
      data-testid="chip-add"
      title="Add collection"
    >
      <IconPlus />
      <span>Add</span>
    </button>
  </div>

  <Sidebar.Content>
    {#if addOpen}
      <div class="add-row">
        <input
          class="input add-input"
          placeholder="Collection name"
          bind:value={addName}
          onkeydown={(e) => { if (e.key === 'Enter') addCustom(); if (e.key === 'Escape') addOpen = false }}
          data-testid="add-collection-input"
        />
        <button type="button" class="btn btn-sm btn-primary" onclick={addCustom} data-testid="add-collection-save">Add</button>
      </div>
    {/if}
    {#if section === 'custom'}
      <Sidebar.Group>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            {#each customs as c (c.name)}
              <Sidebar.MenuItem>
                <Sidebar.MenuButton tooltipContent={c.name} onclick={() => openCustom(c)}>
                  <IconFolder />
                  <span class="capitalize truncate">{c.name}</span>
                </Sidebar.MenuButton>
                <Sidebar.MenuBadge><button type="button" class="chip-del" aria-label={`remove ${c.name}`} onclick={(e) => { e.stopPropagation(); removeCustom(c.name) }}>×</button></Sidebar.MenuBadge>
              </Sidebar.MenuItem>
            {:else}
              <p class="meta-faint add-empty">No custom collections yet.</p>
            {/each}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    {/if}
    {#if section === 'collections'}
    <Sidebar.Group>
      <Sidebar.GroupLabel>{m.rail_group_collections()}</Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each COLLECTION_NAMES as name (name)}
            {@const meta = collectionMeta(name)}
            {@const count = summary?.collections?.[name] ?? 0}
            {@const ColIcon = COLLECTION_ICONS[name] ?? IconInbox}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                isActive={url.view === 'triage' && effectiveCollection(url) === name && !url.host && !url.category}
                tooltipContent={`${meta.label} — ${count}`}
                onclick={() => openCollection(name)}
                data-testid={`collection-${name}`}
              >
                <ColIcon />
                <span class="capitalize">{meta.label}</span>
              </Sidebar.MenuButton>
              {#if count > 0}
                <Sidebar.MenuBadge>{count}</Sidebar.MenuBadge>
              {/if}
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>
    {/if}

    {#if section === 'sites' && hosts.length > 0}
      <Sidebar.Group>
        <Sidebar.GroupLabel>{m.rail_group_sites()}</Sidebar.GroupLabel>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            {#each hosts as h (h.host)}
              <Sidebar.MenuItem>
                <Sidebar.MenuButton
                  isActive={url.view === 'triage' && url.host === h.host}
                  tooltipContent={`${h.host} — ${h.total}`}
                  onclick={() => openHost(h.host)}
                  data-testid={`site-${h.host}`}
                >
                  <span class="site-avatar av-{hostHue(h.host)}" aria-hidden="true">{hostInitial(h.host)}</span>
                  <span class="truncate">{h.host}</span>
                </Sidebar.MenuButton>
                <Sidebar.MenuBadge>{h.total}</Sidebar.MenuBadge>
              </Sidebar.MenuItem>
            {/each}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    {/if}

    {#if section === 'types' && types.length > 0}
      <Sidebar.Group>
        <Sidebar.GroupLabel>{m.rail_group_types()}</Sidebar.GroupLabel>
        <Sidebar.GroupContent>
          <Sidebar.Menu>
            {#each types as [category, count] (category)}
              {@const TypeIcon = TYPE_ICONS[category] ?? IconTag}
              <Sidebar.MenuItem>
                <Sidebar.MenuButton
                  isActive={url.view === 'triage' && url.category === category}
                  tooltipContent={`${category} — ${count}`}
                  onclick={() => openType(category)}
                  data-testid={`type-${category}`}
                >
                  <TypeIcon />
                  <span class="capitalize">{category}</span>
                </Sidebar.MenuButton>
                <Sidebar.MenuBadge>{count}</Sidebar.MenuBadge>
              </Sidebar.MenuItem>
            {/each}
          </Sidebar.Menu>
        </Sidebar.GroupContent>
      </Sidebar.Group>
    {/if}
  </Sidebar.Content>
  <Sidebar.Rail />
</Sidebar.Root>

<style>
  /* Bottom-edge fade: signals more content below the fold (eval pass 2). */
  :global([data-slot='sidebar-content']) {
    mask-image: linear-gradient(to bottom, black calc(100% - 28px), transparent);
    -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 28px), transparent);
  }
  .site-avatar {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 650;
    flex: none;
  }
  .capitalize {
    text-transform: capitalize;
  }
  .sidebar-chips {
    display: flex;
    gap: 2px;
    padding: 8px 8px 6px;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    padding-right: 28px;
  }
  .sidebar-chips::-webkit-scrollbar {
    display: none;
  }
  .sidebar-chips {
    mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);
  }
  .sidebar-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: 7px;
    border: none;
    background: transparent;
    color: var(--color-ink-soft);
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color 140ms var(--ease-out-expo),
      color 140ms var(--ease-out-expo);
  }
  .sidebar-chip:hover {
    background: var(--color-sidebar-accent);
    color: var(--color-ink);
  }
  .sidebar-chip.is-active {
    background: var(--color-sidebar-accent);
    color: var(--color-ink);
    font-weight: 600;
  }
  .sidebar-chip :global(svg) {
    width: 13px;
    height: 13px;
  }
  .add-row {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid var(--color-sidebar-border);
  }
  .add-input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    padding: 5px 8px;
  }
  .add-empty {
    padding: 8px 14px;
    font-size: 12px;
  }
  .chip-del {
    border: none;
    background: transparent;
    color: var(--color-ink-faint);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  .chip-del:hover {
    color: var(--color-state-blocked);
  }
</style>
