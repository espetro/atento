<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query'
  import type { UrlState } from '../lib/urlState'
  import { effectiveCollection } from '../lib/urlState'
  import type { LinkAction, LinkSummary } from '../lib/types'
  import { api, ApiError } from '../lib/api'
  import { reextractBus } from '../lib/events'
  import { handleShellMenuAction, onShellMenuAction } from '../lib/desktop'
  import LinkList from './LinkList.svelte'
  import PreviewPane from './PreviewPane.svelte'
  import * as Resizable from '$lib/components/ui/resizable/index.js'
  import { m } from '../paraglide/messages.js'

  let { url, setUrl }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()
  const collection = $derived(effectiveCollection(url))
  // Preview placement (A2): right column | bottom dock | hidden.
  const layout = $derived(url.layout)

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
      undo = {
        ids,
        action,
        label: action === 'archive' ? m.undo_archived() : m.undo_discarded(),
      }
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
        triageError =
          res.blocked.length === 1
            ? m.restore_failed_one({ count: res.blocked.length })
            : m.restore_failed_other({ count: res.blocked.length })
      } else if (res.updated < ids.length) {
        triageError = m.restore_partial({ updated: res.updated, total: ids.length })
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

  function onReextract(linkId: number) {
    // Preview the link, then ask the preview pane to run its re-extract
    // path (adapter picker when >1 adapter is configured).
    setUrl({ selected: linkId })
    reextractBus.set(linkId)
  }

  // ---- shell-native context menus (desktop only) ------------------------------
  // The shell echoes the picked action back as a `linkinbox:menu-action`
  // CustomEvent; data carries { id, url } from the right-clicked row/pane.
  // Subscribed unconditionally: the native context menu and the web command
  // palette both dispatch through `linkinbox:menu-action`.
  $effect(() => {
    return onShellMenuAction((a) =>
      handleShellMenuAction(a, {
        triage: (id, action) => void onTriage([id], action),
        open: onOpenUrl,
        reextract: onReextract,
      }),
    )
  })
</script>

<div class="triage-shell" class:layout-hidden={layout === 'hidden'} data-testid="triage-shell">
  <Resizable.PaneGroup direction={layout === 'bottom' ? 'vertical' : 'horizontal'} autoSaveId="linkinbox:triage-split">
    <Resizable.Pane defaultSize={30} minSize={15} maxSize={60} class="list-col" data-testid="list-col">
      {#if triageError}
        <div class="triage-error notice notice-bad" role="alert">
          {triageError}
          <button type="button" class="btn btn-sm" onclick={() => (triageError = '')}>{m.action_dismiss()}</button>
        </div>
      {/if}
      <LinkList
        {url}
        {setUrl}
        {collection}
        {onTriage}
        onReextract={onReextract}
        {onOpenUrl}
      />
    </Resizable.Pane>

    {#if layout !== 'hidden' && (layout === 'right' || url.selected != null)}
      <Resizable.Handle withHandle data-testid="list-resizer" />
      <Resizable.Pane minSize={25} class={`preview-col${url.selected != null ? ' mobile-overlay' : ''}`} data-testid="preview-col">
        <div class="preview-col-inner">
          {#if url.selected != null}
            <button type="button" class="preview-back" onclick={() => setUrl({ selected: null })}>
              {m.preview_back()}
            </button>
          {/if}
          <PreviewPane id={url.selected} {onTriage} {collection} />
        </div>
      </Resizable.Pane>
    {/if}
  </Resizable.PaneGroup>
</div>

{#if undo}
  <div class="undo-toast" role="status" data-testid="undo-toast">
    <span>{undo.ids.length === 1 ? m.undo_toast_one({ label: undo.label }) : m.undo_toast_other({ label: undo.label, count: undo.ids.length })}</span>
    <button type="button" class="btn btn-sm btn-ghost" onclick={undoTriage}>{m.action_undo()}</button>
  </div>
{/if}

<style>
  .triage-shell {
    height: 100%;
    min-height: 0;
    flex: 1;
  }
  .triage-shell :global([data-pane-group]) {
    height: 100%;
    min-height: 0;
  }
  /* Panes own sizing (paneforge); columns are just containers. */
  .triage-shell :global(.list-col) {
    min-height: 0;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .triage-shell :global(.preview-col) {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .preview-col-inner {
    flex: 1;
    min-height: 0;
    min-width: 0;
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
    animation: toast-in 240ms var(--ease-out-expo);
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(10px);
    }
  }
  @media (max-width: 759px) {
    .triage-shell {
      flex-direction: column;
    }
    .triage-shell :global(.list-col) {
      width: 100%;
      border-right: none;
      flex: 1;
    }
    .triage-shell :global(.preview-col) {
      display: none;
    }
    .triage-shell :global(.preview-col.mobile-overlay) {
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
    /* Paneforge owns column sizing; mid-width screens just use the saved split. */
  }
</style>
