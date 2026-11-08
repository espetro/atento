<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query'
  import type { UrlState } from '../lib/urlState'
  import { effectiveCollection } from '../lib/urlState'
  import type { LinkAction, LinkSummary } from '../lib/types'
  import { api, ApiError } from '../lib/api'
  import { reextractBus } from '../lib/events'
  import LinkList from './LinkList.svelte'
  import PreviewPane from './PreviewPane.svelte'

  let { url, setUrl }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()
  const collection = $derived(effectiveCollection(url))
  // Preview placement (A2): right column | bottom dock | hidden.
  const layout = $derived(url.layout)

  let listActions = $state<{
    selectedIds: () => number[]
    selectedLink: () => LinkSummary | null
  } | null>(null)

  let triageError = $state('')
  let undo = $state<{ ids: number[]; action: LinkAction; label: string } | null>(null)
  let undoTimer: ReturnType<typeof setTimeout> | undefined

  const UNDO_ACTIONS: LinkAction[] = ['archive', 'discard']

  /**
   * Triage mutation: optimistic removal from the loaded lists, rollback by
   * invalidation on error, 6s undo toast for the destructive actions.
   */
  async function onTriage(ids: number[], action: LinkAction) {
    triageError = ''
    const idSet = new Set(ids)
    // Optimistic: archive/schedule/discard leave most collections; read_now
    // stays. Remove the rows from every cached links page.
    if (action !== 'read_now') {
      queryClient.setQueriesData<{ items: LinkSummary[]; total: number }>(
        { queryKey: ['links'] },
        (old) => {
          if (!old) return old
          const items = old.items.filter((l) => !idSet.has(l.id))
          return { ...old, items, total: Math.max(0, old.total - (old.items.length - items.length)) }
        },
      )
    }
    try {
      await api.triage(ids, action)
    } catch (err) {
      // Rollback: drop the optimistic pages and refetch the truth.
      await queryClient.invalidateQueries({ queryKey: ['links'] })
      triageError = err instanceof ApiError ? err.message : String(err)
      return
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['links'] }),
      queryClient.invalidateQueries({ queryKey: ['collections-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
    ])
    if (UNDO_ACTIONS.includes(action)) {
      undo = { ids, action, label: action === 'archive' ? 'archived' : 'discarded' }
      clearTimeout(undoTimer)
      undoTimer = setTimeout(() => (undo = null), 6000)
    }
  }

  async function undoTriage() {
    if (!undo) return
    const { ids } = undo
    undo = null
    triageError = ''
    try {
      const res = await api.restore(ids)
      if (res.updated === 0) {
        triageError = `restore failed: ${res.blocked.length} link${res.blocked.length === 1 ? '' : 's'} not restorable`
      } else if (res.updated < ids.length) {
        triageError = `restored ${res.updated} of ${ids.length} links`
      }
    } catch (err) {
      triageError = err instanceof ApiError ? err.message : String(err)
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['links'] }),
      queryClient.invalidateQueries({ queryKey: ['collections-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
    ])
  }

  function onOpenUrl(linkUrl: string) {
    window.open(linkUrl, '_blank', 'noopener')
  }

  function onReextract(link: LinkSummary) {
    // Preview the link, then ask the preview pane to run its re-extract
    // path (adapter picker when >1 adapter is configured).
    setUrl({ selected: link.id })
    reextractBus.set(link.id)
  }
</script>

<div class="triage-shell" class:layout-bottom={layout === 'bottom'} class:layout-hidden={layout === 'hidden'} data-testid="triage-shell">
  <div class="list-col" class:has-selection={url.selected != null}>
    {#if triageError}
      <div class="triage-error notice notice-bad" role="alert">
        {triageError}
        <button type="button" class="btn btn-sm" onclick={() => (triageError = '')}>dismiss</button>
      </div>
    {/if}
    <LinkList
      {url}
      {setUrl}
      {collection}
      {onTriage}
      onReextract={onReextract}
      {onOpenUrl}
      registerActions={(a) => (listActions = a)}
    />
  </div>

  {#if layout !== 'hidden' && (layout === 'right' || url.selected != null)}
    <div class="preview-col" class:mobile-overlay={url.selected != null} data-testid="preview-col">
      {#if url.selected != null}
        <button type="button" class="preview-back" onclick={() => setUrl({ selected: null })}>
          ‹ back
        </button>
      {/if}
      <PreviewPane id={url.selected} {onTriage} {collection} />
    </div>
  {/if}
</div>

{#if undo}
  <div class="undo-toast" role="status" data-testid="undo-toast">
    <span>{undo.label} {undo.ids.length} link{undo.ids.length === 1 ? '' : 's'}</span>
    <button type="button" class="btn btn-sm btn-ghost" onclick={undoTriage}>undo</button>
  </div>
{/if}

<style>
  .triage-shell {
    display: flex;
    height: 100%;
    min-height: 0;
    flex: 1;
  }
  .list-col {
    width: 400px;
    flex: none;
    border-right: 1px solid var(--color-line);
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  /* ?layout=bottom: the list goes full-width on top, the preview docks
     below it (Gmail-style). ?layout=hidden drops the preview entirely. */
  .triage-shell.layout-bottom,
  .triage-shell.layout-hidden {
    flex-direction: column;
  }
  .layout-bottom .list-col,
  .layout-hidden .list-col {
    width: 100%;
    flex: 1;
    border-right: none;
  }
  .layout-bottom .preview-col {
    flex: none;
    height: 46%;
    min-height: 220px;
    border-top: 1px solid var(--color-line);
  }
  .preview-col {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .triage-error {
    margin: 8px 10px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12.5px;
  }
  .preview-back {
    display: none;
  }
  .undo-toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--color-ink);
    color: var(--color-surface);
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    box-shadow: var(--shadow-pop);
    z-index: 60;
  }
  @media (max-width: 759px) {
    .triage-shell {
      flex-direction: column;
    }
    .list-col {
      width: 100%;
      border-right: none;
      flex: 1;
    }
    .preview-col {
      display: none;
    }
    .preview-col.mobile-overlay {
      display: flex;
      position: fixed;
      inset: 0;
      z-index: 45;
      background: var(--color-surface);
    }
    .preview-back {
      display: inline-block;
      position: absolute;
      top: 8px;
      left: 10px;
      z-index: 5;
      background: var(--color-surface-raised);
      border: 1px solid var(--color-line);
      border-radius: 8px;
      padding: 4px 10px;
      font-size: 13px;
      cursor: pointer;
      color: var(--color-ink);
    }
  }
  @media (min-width: 760px) and (max-width: 1099px) {
    .list-col {
      width: 340px;
    }
  }
</style>
