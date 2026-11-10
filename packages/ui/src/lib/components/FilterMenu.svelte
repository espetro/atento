<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { api } from '../api'
  import { m } from '../../paraglide/messages.js'
  import { density, setDensity } from '../prefs'
  import type { UrlState } from '../urlState'
  import { LAYOUT_MODES, LINK_CATEGORIES, PIPELINE_STATES } from '../types'

  /**
   * Filter + layout dropdown (A4): the state/category/host/stale controls and
   * Reset that used to live as always-visible selects, plus the A2 layout
   * options (density, preview placement). All filter state stays in the URL.
   */
  let {
    url,
    setUrl,
  }: {
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
  } = $props()

  // Host options come from the pipeline histogram (same 30s cache the rail uses).
  const pipelineQuery = createQuery(() => ({
    queryKey: ['pipeline'],
    queryFn: () => api.pipeline(),
    staleTime: 30_000,
  }))
  const hosts = $derived(pipelineQuery.data?.byHost ?? [])

  const LAYOUT_LABELS: Record<string, string> = {
    right: m.layout_mode_right(),
    bottom: m.layout_mode_bottom(),
    hidden: m.layout_mode_hidden(),
  }

  function pick(next: Partial<UrlState>) {
    setUrl({ ...next, selected: null })
  }

  function resetFilters() {
    pick({ q: '', state: '', category: '', host: '', stale: false })
  }

  const filtersActive = $derived(
    url.q !== '' || url.state !== '' || url.category !== '' || url.host !== '' || url.stale,
  )
</script>

<div class="filter-menu" role="group" aria-label={m.filters_aria_label()} data-testid="filter-menu">
  <div class="menu-section">
    <div class="menu-label">{m.menu_filters()}</div>
    <label class="field">
      <span class="field-label">{m.filter_state()}</span>
      <select
        class="select"
        data-testid="state-filter"
        value={url.state}
        onchange={(e) => pick({ state: (e.currentTarget as HTMLSelectElement).value })}
      >
        <option value="">{m.filter_all_states()}</option>
        {#each PIPELINE_STATES as s (s)}
          <option value={s}>{s.replace(/_/g, ' ')}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span class="field-label">{m.filter_category()}</span>
      <select
        class="select"
        data-testid="category-filter"
        value={url.category}
        onchange={(e) => pick({ category: (e.currentTarget as HTMLSelectElement).value })}
      >
        <option value="">{m.filter_all_categories()}</option>
        {#each LINK_CATEGORIES as c (c)}
          <option value={c}>{c}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span class="field-label">{m.filter_host()}</span>
      <select
        class="select"
        data-testid="host-filter"
        value={url.host}
        onchange={(e) => pick({ host: (e.currentTarget as HTMLSelectElement).value })}
      >
        <option value="">{m.filter_all_hosts()}</option>
        {#each hosts as h (h.host)}
          <option value={h.host}>{h.host}</option>
        {/each}
      </select>
    </label>
    <label class="field field-inline">
      <input
        type="checkbox"
        data-testid="stale-filter"
        checked={url.stale}
        onchange={(e) => pick({ stale: (e.currentTarget as HTMLInputElement).checked })}
      />
      <span class="field-label">{m.filter_stale_only()}</span>
    </label>
    <button
      type="button"
      class="btn btn-sm btn-ghost menu-reset"
      disabled={!filtersActive}
      onclick={resetFilters}
      data-testid="filter-reset"
    >
      {m.filter_reset()}
    </button>
  </div>

  <div class="menu-section">
    <div class="menu-label">{m.menu_layout()}</div>
    <div class="density-row" role="group" aria-label={m.density_aria_label()}>
      <button
        type="button"
        class="density-btn"
        class:is-active={$density === 'compact'}
        aria-pressed={$density === 'compact'}
        onclick={() => setDensity('compact')}
        data-testid="density-compact"
      >
        {m.density_compact()}
      </button>
      <button
        type="button"
        class="density-btn"
        class:is-active={$density === 'comfortable'}
        aria-pressed={$density === 'comfortable'}
        onclick={() => setDensity('comfortable')}
        data-testid="density-comfortable"
      >
        {m.density_comfortable()}
      </button>
    </div>
    <label class="field">
      <span class="field-label">{m.filter_preview()}</span>
      <select
        class="select"
        data-testid="layout-select"
        value={url.layout}
        onchange={(e) => setUrl({ layout: (e.currentTarget as HTMLSelectElement).value as UrlState['layout'] })}
      >
        {#each LAYOUT_MODES as mode (mode)}
          <option value={mode}>{LAYOUT_LABELS[mode] ?? mode}</option>
        {/each}
      </select>
    </label>
    <p class="meta-faint menu-note">{m.layout_note()}</p>
  </div>
</div>

<style>
  .filter-menu {
    position: absolute;
    top: calc(100% + 4px);
    /* Anchored to the button's right edge (it sits at the card's right) and
       clamped so it can never extend past the app area. */
    right: 0;
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 90px);
    overflow-y: auto;
    z-index: 55;
    width: 232px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--color-line);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-pop, 0 8px 24px rgb(0 0 0 / 0.12));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .menu-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .menu-section + .menu-section {
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
  }
  .menu-label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-ink-faint);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .field-inline {
    flex-direction: row;
    align-items: center;
    gap: 7px;
    padding: 2px 0;
  }
  .field-inline input {
    accent-color: var(--color-accent-blue);
    margin: 0;
  }
  .field-label {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--color-ink-soft);
  }
  .select {
    padding: 5px 8px;
    font-size: 12.5px;
  }
  .menu-reset {
    align-self: flex-start;
  }
  .density-row {
    display: flex;
    gap: 4px;
    background: var(--color-surface-sunken);
    border-radius: 8px;
    padding: 3px;
  }
  .density-btn {
    flex: 1;
    padding: 4px 8px;
    font-size: 12px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--color-ink-soft);
    cursor: pointer;
  }
  .density-btn.is-active {
    background: var(--color-surface-raised);
    color: var(--color-ink);
    font-weight: 600;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }
  .menu-note {
    margin: 0;
  }
</style>
