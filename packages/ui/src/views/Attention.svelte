<script lang="ts">
  import { onMount } from 'svelte'
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import type { UrlState } from '../lib/urlState'
  import { effectiveCollection } from '../lib/urlState'
  import type { CollectionName, LinkAction, LinkSummary } from '../lib/types'
  import { api, ApiError } from '../lib/api'
  import { reextractBus } from '../lib/events'
  import { collectionMeta } from '../lib/copy'
  import { copyText } from '../lib/format'
  import LinkList from './LinkList.svelte'
  import PreviewPane from './PreviewPane.svelte'
  import CopyButton from '../components/CopyButton.svelte'
  import Dialog from '../components/Dialog.svelte'
  import StateChip from '../components/StateChip.svelte'

  let { url, setUrl }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()
  const collection = $derived(effectiveCollection(url))
  const meta = $derived(collectionMeta(collection))

  const summaryQuery = createQuery(() => ({
    queryKey: ['collections-summary'],
    queryFn: () => api.collectionsSummary(),
    staleTime: 10_000,
  }))
  const summary = $derived(summaryQuery.data ?? null)
  const collectionCount = $derived(summary?.collections?.[collection as CollectionName] ?? 0)
  const attentionTotal = $derived(
    ['needs_login', 'blocked', 'errored', 'review'].reduce(
      (n, k) => n + ((summary?.collections as Record<string, number> | undefined)?.[k] ?? 0),
      0,
    ),
  )

  const loginHosts = $derived(summary?.needsLoginHosts ?? [])

  let triageError = $state('')
  let undo = $state<{ ids: number[]; label: string } | null>(null)
  let undoTimer: ReturnType<typeof setTimeout> | undefined

  async function onTriage(ids: number[], action: LinkAction) {
    triageError = ''
    try {
      await api.triage(ids, action)
    } catch (err) {
      triageError = err instanceof ApiError ? err.message : String(err)
      await queryClient.invalidateQueries({ queryKey: ['links'] })
      return
    }
    if (action === 'archive' || action === 'discard') {
      undo = { ids, label: action === 'archive' ? 'archived' : 'discarded' }
      clearTimeout(undoTimer)
      undoTimer = setTimeout(() => (undo = null), 6000)
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['links'] }),
      queryClient.invalidateQueries({ queryKey: ['collections-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
    ])
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
    setUrl({ selected: link.id })
    reextractBus.set(link.id)
  }

  async function copyLoginCommand(host: string) {
    await copyText(`linkinbox login ${host}`)
  }

  // ---- exit-code bridge (arriving from run view with needsAction) -----------
  let bridgeBanner = $state(false)
  onMount(() => {
    try {
      bridgeBanner = sessionStorage.getItem('linkinbox:attention-from-run') === '1'
      if (bridgeBanner) sessionStorage.removeItem('linkinbox:attention-from-run')
    } catch {
      bridgeBanner = false
    }
  })

  // ---- bulk per-host actions -------------------------------------------------
  let bulkTarget = $state<{ host: string; action: LinkAction; ids: number[] } | null>(null)
  let bulkBusy = $state(false)

  async function askBulk(host: string, action: LinkAction) {
    triageError = ''
    try {
      const res = await api.links({ collection, host, limit: 200 })
      if (res.items.length === 0) {
        triageError = `no ${collectionMeta(collection).label.toLowerCase()} links found for ${host}`
        return
      }
      bulkTarget = { host, action, ids: res.items.map((l) => l.id) }
    } catch (err) {
      triageError = err instanceof ApiError ? err.message : String(err)
    }
  }

  async function confirmBulk() {
    if (!bulkTarget) return
    const { ids, action, host } = bulkTarget
    bulkBusy = true
    try {
      const res = await api.triage(ids, action)
      bulkTarget = null
      if (action === 'archive' || action === 'discard') {
        undo = { ids, label: `${action === 'archive' ? 'archived' : 'discarded'} (${host})` }
        clearTimeout(undoTimer)
        undoTimer = setTimeout(() => (undo = null), 6000)
      }
      if (res.updated < ids.length) {
        triageError = `triaged ${res.updated} of ${ids.length} links for ${host}`
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['links'] }),
        queryClient.invalidateQueries({ queryKey: ['collections-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
      ])
    } catch (err) {
      triageError = err instanceof ApiError ? err.message : String(err)
    } finally {
      bulkBusy = false
    }
  }

  // ---- "Check sessions" — no HTTP verify endpoint exists; the honest v1 is
  // a pipeline pass (saved profiles are picked up headlessly) plus the CLI
  // verify command. ---------------------------------------------------------
  let checking = $state(false)
  let sessionNote = $state('')

  async function checkSessions() {
    if (checking) return
    checking = true
    sessionNote = ''
    try {
      await api.run()
      sessionNote = 'run finished — verify saved sessions with `linkinbox login list`'
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['links'] }),
        queryClient.invalidateQueries({ queryKey: ['collections-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
        queryClient.invalidateQueries({ queryKey: ['runs'] }),
      ])
    } catch (err) {
      sessionNote = err instanceof ApiError ? err.message : String(err)
    } finally {
      checking = false
    }
  }

  function switchAttention(name: string) {
    setUrl({ view: 'attention', collection: name, selected: null, host: '', q: '', state: '', category: '', stale: false })
  }
</script>

<div class="att-shell">
  <div class="att-main">
    {#if bridgeBanner}
      <div class="bridge-banner notice notice-warn" role="status" data-testid="attention-bridge">
        last run finished — {attentionTotal ?? ''} links need you
        <button type="button" class="btn btn-sm btn-ghost" onclick={() => (bridgeBanner = false)}>dismiss</button>
      </div>
    {/if}
    <div class="att-switch" role="tablist" aria-label="Attention collections">
      {#each ['needs_login', 'blocked', 'errored', 'review'] as name (name)}
        {@const m = collectionMeta(name)}
        {@const count = summary?.collections?.[name as CollectionName] ?? 0}
        <button
          type="button"
          class="att-tab"
          class:is-active={collection === name}
          role="tab"
          aria-selected={collection === name}
          onclick={() => switchAttention(name)}
          data-testid="attention-{name}"
        >
          <StateChip collection={name} />
          <span class="meta">{count}</span>
        </button>
      {/each}
    </div>

    <section class="explainer pane">
      <h2 class="explainer-title">{meta.label} <span class="meta">{collectionCount} links</span></h2>
      <p class="explainer-text">{meta.meaning}</p>
      {#if meta.remediation}<p class="explainer-text"><strong>Next step:</strong> {meta.remediation}</p>{/if}

      {#if collection === 'needs_login' && loginHosts.length > 0}
        <table class="host-table">
          <thead>
            <tr><th>host</th><th>links</th><th>next step</th><th></th></tr>
          </thead>
          <tbody>
            {#each loginHosts as h (h.host)}
              <tr>
                <td class="mono">{h.host}</td>
                <td>{h.count}</td>
                <td class="mono meta">linkinbox login {h.host}</td>
                <td class="host-actions">
                  <CopyButton text={`linkinbox login ${h.host}`} label="copy" />
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    onclick={() => void askBulk(h.host, 'archive')}
                    data-testid="bulk-archive-{h.host}"
                  >archive all</button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    onclick={() => void askBulk(h.host, 'discard')}
                    data-testid="bulk-discard-{h.host}"
                  >discard all</button>
                </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="host-actions-row">
            <button
              type="button"
              class="btn btn-sm"
              disabled={checking}
              onclick={() => void checkSessions()}
              data-testid="check-sessions"
            >{checking ? 'checking…' : 'Check sessions'}</button>
            <span class="meta">re-runs the pipeline so saved logins are picked up; there is no standalone session-verify endpoint yet</span>
          </div>
          {#if sessionNote}<p class="meta" data-testid="session-note">{sessionNote}</p>{/if}
        <details class="login-help">
          <summary class="meta">how login works</summary>
          <p class="meta">
            A headed browser opens for the host; you log in once and the profile is saved under
            <span class="mono">~/.linkinbox/profiles/&lt;host&gt;</span>. The next pipeline run picks
            it up headlessly and parked links resume automatically.
          </p>
        </details>
      {/if}

      {#if collection === 'review'}
        <p class="meta">Hosts on the review list are never fetched automatically — review is manual by design.</p>
      {/if}
    </section>

    <div class="att-body">
      {#if triageError}
        <div class="notice notice-bad" role="alert">
          {triageError}
          <button type="button" class="btn btn-sm" onclick={() => (triageError = '')}>dismiss</button>
        </div>
      {/if}
      <div class="att-cols">
        <div class="att-list">
          <LinkList
            {url}
            {setUrl}
            {collection}
            {onTriage}
            {onReextract}
            {onOpenUrl}
            registerActions={() => {}}
          />
        </div>
        <div class="att-preview">
          <PreviewPane id={url.selected} {onTriage} {collection} />
        </div>
      </div>
    </div>
  </div>
</div>

{#if undo}
  <div class="undo-toast" role="status">
    <span>{undo.label} {undo.ids.length} link{undo.ids.length === 1 ? '' : 's'}</span>
    <button type="button" class="btn btn-sm btn-ghost" onclick={undoTriage}>undo</button>
  </div>
{/if}

<Dialog open={bulkTarget != null} labelledBy="bulk-title" onClose={() => (bulkTarget = null)}>
  {#if bulkTarget}
    <h2 id="bulk-title" class="picker-title">
      {bulkTarget.action === 'archive' ? 'Archive' : 'Discard'} {bulkTarget.ids.length} link{bulkTarget.ids.length === 1 ? '' : 's'} from {bulkTarget.host}?
    </h2>
    <p class="meta">
      Every {collectionMeta(collection).label.toLowerCase()} link from <span class="mono">{bulkTarget.host}</span> will be {bulkTarget.action === 'archive' ? 'archived' : 'discarded'}. You can undo from the toast.
    </p>
    <div class="picker-foot">
      <button type="button" class="btn btn-sm" onclick={() => (bulkTarget = null)} disabled={bulkBusy}>cancel</button>
      <button type="button" class="btn btn-sm btn-primary" onclick={() => void confirmBulk()} disabled={bulkBusy} data-testid="bulk-confirm">
        {bulkBusy ? 'working…' : 'confirm'}
      </button>
    </div>
  {/if}
</Dialog>

<style>
  .att-shell {
    display: flex;
    height: 100%;
    min-height: 0;
    flex: 1;
  }
  .att-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .att-switch {
    display: flex;
    gap: 6px;
    padding: 12px 16px 0;
    flex-wrap: wrap;
  }
  .att-tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1px solid var(--color-line);
    background: var(--color-surface-raised);
    cursor: pointer;
    font-size: 12.5px;
    color: var(--color-ink-soft);
  }
  .att-tab.is-active {
    border-color: var(--color-accent);
    color: var(--color-ink);
    font-weight: 600;
  }
  .explainer {
    margin: 12px 16px 0;
    padding: 14px 18px;
  }
  .explainer-title {
    font-size: 16px;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .explainer-text {
    font-size: 13.5px;
    line-height: 1.55;
    margin-top: 6px;
    color: var(--color-ink);
  }
  .host-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
    font-size: 13px;
  }
  .host-table th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-ink-faint);
    padding: 4px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .host-table td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .login-help {
    margin-top: 10px;
  }
  .host-actions {
    white-space: nowrap;
  }
  .host-actions-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .bridge-banner {
    margin: 12px 16px 0;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .picker-title {
    font-size: 15px;
    margin: 0 0 8px;
  }
  .picker-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 14px;
  }
  .att-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 16px 16px;
  }
  .att-cols {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 12px;
  }
  .att-list {
    width: 380px;
    flex: none;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .att-preview {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
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
  @media (max-width: 900px) {
    .att-cols {
      flex-direction: column;
    }
    .att-list {
      width: 100%;
      max-height: 40%;
    }
  }
</style>
