<script lang="ts">
  import Dialog from './Dialog.svelte'
  import { paletteCommands, type PaletteCommand, type PaletteDeps } from '../lib/palette'
  import type { UrlState } from '../lib/urlState'
  import { m } from '../paraglide/messages.js'

  /**
   * ⌘K command palette (P1.1). One fuzzy list covering navigation, filters,
   * layout/density, app actions, and — when a link is selected — the triage
   * actions, which dispatch through `linkinbox:menu-action` so the views'
   * existing handlers serve both native menus and this palette.
   */
  let {
    open,
    url,
    setUrl,
    invalidate,
    onClose,
  }: {
    open: boolean
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    invalidate: () => void
    onClose: () => void
  } = $props()

  let query = $state('')
  let active = $state(0)
  let listEl = $state<HTMLElement | null>(null)

  const deps: PaletteDeps = { setUrl: (next) => setUrl(next), invalidate: () => invalidate() }
  const items = $derived(paletteCommands(url, query, deps))

  // Fresh state every open.
  $effect(() => {
    if (open) {
      query = ''
      active = 0
    }
  })
  // Clamp the active row when the filtered list shrinks.
  $effect(() => {
    if (active > items.length - 1) active = Math.max(0, items.length - 1)
  })
  // Keep the active row visible while arrow-keying.
  $effect(() => {
    active
    listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  })

  function pick(item: PaletteCommand) {
    item.run()
    onClose()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = Math.min(active + 1, items.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.max(active - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[active]
      if (item) pick(item)
    } else if (e.key === 'Home') {
      e.preventDefault()
      active = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      active = items.length - 1
    }
  }
</script>

<Dialog {open} labelledBy="palette-title" {onClose} initialFocus="input">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette" onkeydown={onKeydown} data-testid="command-palette">
    <h2 id="palette-title" class="sr-only">{m.palette_title()}</h2>
    <input
      class="palette-input"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="palette-list"
      aria-activedescendant={items[active] ? `palette-item-${items[active].id}` : ''}
      bind:value={query}
      placeholder={m.palette_placeholder()}
      aria-label={m.palette_title()}
      autocomplete="off"
      spellcheck="false"
    />
    <ul id="palette-list" class="palette-list" role="listbox" bind:this={listEl}>
      {#each items as item, i (item.id)}
        {@const Icon = item.icon}
        <li role="option" id="palette-item-{item.id}" aria-selected={i === active}>
          <button
            type="button"
            class="palette-item"
            class:active={i === active}
            onclick={() => pick(item)}
            onmousemove={() => (active = i)}
            tabindex="-1"
          >
            {#if Icon}<Icon />{/if}
            <span class="palette-label">{item.label}</span>
            {#if item.hint}<kbd class="kbd">{item.hint}</kbd>{/if}
          </button>
        </li>
      {:else}
        <li class="palette-empty">{m.palette_no_results()}</li>
      {/each}
    </ul>
  </div>
</Dialog>

<style>
  .palette {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 100%;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .palette-input {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--color-line);
    background: transparent;
    padding: 14px 16px;
    font-size: 15px;
    color: var(--color-ink);
    outline: none;
  }
  .palette-list {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    min-height: 0;
  }
  .palette-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: none;
    background: transparent;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13.5px;
    color: var(--color-ink);
    cursor: pointer;
    text-align: left;
  }
  .palette-item :global(svg) {
    flex: none;
    color: var(--color-ink-soft);
    font-size: 15px;
  }
  .palette-item.active {
    background: var(--color-surface-sunken, rgb(0 0 0 / 0.05));
  }
  .palette-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .palette-empty {
    padding: 18px 12px;
    text-align: center;
    color: var(--color-ink-soft);
    font-size: 13px;
  }
</style>
