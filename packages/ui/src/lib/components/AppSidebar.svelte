<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { api } from '../api'
  import { COLLECTION_NAMES } from '../types'
  import { collectionMeta } from '../copy'
  import type { UrlState } from '../urlState'
  import * as Sidebar from '$lib/components/ui/sidebar/index.js'
  import IconInbox from '~icons/lucide/inbox'
  import IconPlay from '~icons/lucide/play'
  import IconChartBar from '~icons/lucide/chart-bar'
  import IconSettings from '~icons/lucide/settings'
  import IconPlus from '~icons/lucide/plus'
  import IconCommand from '~icons/lucide/command'
  import { m } from '../../paraglide/messages.js'

  /**
   * Primary navigation sidebar (Distill library reference): collections as
   * colored dots + labels + trailing counts; icons only for app-level
   * actions. shadcn Sidebar (icon collapse) + Sheet drawer on mobile.
   */
  let { url, setUrl, onIngest }: {
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    onIngest?: () => void
  } = $props()

  const summaryQuery = createQuery(() => ({
    queryKey: ['collections-summary'],
    queryFn: () => api.collectionsSummary(),
  }))
  const summary = $derived(summaryQuery.data)

  const COLLECTION_COLORS: Record<string, string> = {
    enriched: 'var(--color-state-enriched)',
    pending: 'var(--color-state-pending)',
    needs_login: 'var(--color-state-needs-login)',
    blocked: 'var(--color-state-blocked)',
    errored: 'var(--color-state-errored)',
    review: 'var(--color-state-review)',
    triaged: 'var(--color-state-triaged)',
  }

  function openCollection(name: string) {
    setUrl({ view: 'triage', collection: name as UrlState['collection'], selected: null })
  }
</script>

<Sidebar.Root collapsible="icon" data-testid="app-sidebar">
  <Sidebar.Header class="border-b border-sidebar-border">
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
  </Sidebar.Header>

  <Sidebar.Content>
    <Sidebar.Group>
      <Sidebar.GroupLabel>{m.rail_group_collections()}</Sidebar.GroupLabel>
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each COLLECTION_NAMES as name (name)}
            {@const meta = collectionMeta(name)}
            {@const count = summary?.collections?.[name] ?? 0}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                isActive={url.view === 'triage' && url.collection === name}
                tooltipContent={`${meta.label} — ${count}`}
                onclick={() => openCollection(name)}
                data-testid={`collection-${name}`}
              >
                <span class="dot" style={`background: ${COLLECTION_COLORS[name] ?? 'var(--color-ink-faint)'};`}></span>
                <span>{meta.label}</span>
              </Sidebar.MenuButton>
              {#if count > 0}
                <Sidebar.MenuBadge>{count}</Sidebar.MenuBadge>
              {/if}
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

  <Sidebar.Footer class="border-t border-sidebar-border">
    <Sidebar.Menu>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton tooltipContent={m.nav_ingest()} onclick={() => onIngest?.()} data-testid="nav-ingest">
          <IconPlus />
          <span>{m.nav_ingest()}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          isActive={url.view === 'run'}
          tooltipContent={m.nav_run()}
          onclick={() => setUrl({ view: 'run', selected: null })}
        >
          <IconPlay />
          <span>{m.nav_run()}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          isActive={url.view === 'metrics'}
          tooltipContent="Metrics"
          onclick={() => setUrl({ view: 'metrics', selected: null })}
        >
          <IconChartBar />
          <span>Metrics</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          isActive={url.view === 'settings'}
          tooltipContent={m.nav_settings()}
          onclick={() => setUrl({ view: 'settings', selected: null })}
        >
          <IconSettings />
          <span>{m.nav_settings()}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem>
        <Sidebar.MenuButton tooltipContent={`${m.palette_title()} ⌘K`} onclick={() => window.dispatchEvent(new CustomEvent('linkinbox:palette'))}>
          <IconCommand />
          <span>{m.palette_title()}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>
  <Sidebar.Rail />
</Sidebar.Root>
