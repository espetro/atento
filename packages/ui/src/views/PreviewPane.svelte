<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import * as v from 'valibot'
  import { createForm, Form, Field, type FormStore } from '@formisch/svelte'
  import { api, ApiError } from '../lib/api'
  import { onShortcut } from '../lib/keyboard'
  import { reextractBus } from '../lib/events'
  import { timeAgo, truncate } from '../lib/format'
  import { reasonLabel } from '../lib/copy'
  import type { UrlState } from '../lib/urlState'
  import type { LinkAction, LinkDetail, PreviewTab } from '../lib/types'
  import { PREVIEW_TABS } from '../lib/types'
  import StateChip from '../components/StateChip.svelte'
  import CopyButton from '../components/CopyButton.svelte'
  import Dialog from '../components/Dialog.svelte'

  let {
    id,
    url,
    setUrl,
    onTriage,
    collection,
  }: {
    id: number | null
    url: UrlState
    setUrl: (next: Partial<UrlState>) => void
    onTriage: (ids: number[], action: LinkAction) => Promise<void>
    collection: string
  } = $props()

  const queryClient = useQueryClient()

  const detailQuery = createQuery(() => ({
    queryKey: ['link', id],
    queryFn: () => api.link(id!),
    enabled: id != null,
  }))

  const detail = $derived<LinkDetail | null>(detailQuery.data ?? null)

  // Browsers for the re-extract adapter picker.
  const browsersQuery = createQuery(() => ({
    queryKey: ['browsers'],
    queryFn: () => api.browsers(),
    staleTime: 30_000,
  }))
  const adapters = $derived(browsersQuery.data?.adapters ?? [])

  // ---- tabs -----------------------------------------------------------------

  const TAB_LABELS: Record<PreviewTab, string> = {
    reader: 'Reader',
    metadata: 'Metadata',
    snapshot: 'Snapshot',
    live: 'Live',
  }

  $effect(() => {
    const offs = PREVIEW_TABS.map((t, i) =>
      onShortcut(String(i + 1), () => setUrl({ tab: t })),
    )
    return () => offs.forEach((off) => off())
  })

  const frameable = $derived(detail?.stateData?.frameable === true)
  let snapshotMissing = $state(false)
  $effect(() => {
    // Reset the artifact-missing flag whenever the link changes.
    void id
    snapshotMissing = false
  })

  // ---- reader ----------------------------------------------------------------

  const readerHtml = $derived.by(() => {
    const md = detail?.extracted_content ?? ''
    if (md.trim() === '') return ''
    const out = marked.parse(md, { async: false })
    return typeof out === 'string' ? DOMPurify.sanitize(out) : ''
  })

  // ---- metadata form (formisch + valibot) ------------------------------------

  const metaSchema = v.object({
    title: v.string(),
    note: v.string(),
    tags: v.string(),
  })
  type MetaForm = v.InferInput<typeof metaSchema>

  type MetaSchema = typeof metaSchema
  let metaForm = $state<FormStore<MetaSchema> | null>(null)
  $effect(() => {
    if (!detail) return
    metaForm = createForm({
      schema: metaSchema,
      initialInput: {
        title: detail.title ?? '',
        note: detail.note ?? '',
        tags: (detail.tags ?? []).join(', '),
      },
    })
  })

  let metaSaving = $state(false)
  let metaError = $state('')

  // Blur-save reads the live DOM values (the Field snippets own the inputs).
  function readMetaDom() {
    const q = (t: string) =>
      (document.querySelector(`[data-testid="${t}"]`) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? ''
    return { title: q('edit-title'), note: q('edit-note'), tags: q('edit-tags') }
  }

  async function saveMeta(output?: MetaForm) {
    if (id == null) return
    const dom = output === undefined ? readMetaDom() : null
    const title = output?.title ?? dom?.title ?? ''
    const note = output?.note ?? dom?.note ?? ''
    const tagsRaw = output?.tags ?? dom?.tags ?? ''
    metaSaving = true
    metaError = ''
    try {
      const tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '')
      await api.patchLink(id, {
        title: title === '' ? null : title,
        note: note === '' ? null : note,
        tags: tags.length === 0 ? null : tags,
      })
      await queryClient.invalidateQueries({ queryKey: ['link', id] })
      await queryClient.invalidateQueries({ queryKey: ['links'] })
    } catch (err) {
      metaError = err instanceof ApiError ? err.message : String(err)
    } finally {
      metaSaving = false
    }
  }

  function onMetaSubmit(output: MetaForm) {
    return saveMeta(output)
  }
  // Save-on-blur: PATCH the user fields when an input loses focus.
  function saveMetaBlur() {
    void saveMeta()
  }

  // ---- actions ----------------------------------------------------------------

  // Errors surface in the shell's triage-error alert; the undo toast for
  // destructive actions lives in Triage.svelte (one toast, one code path).
  async function act(action: LinkAction) {
    if (id == null) return
    await onTriage([id], action)
  }

  // Re-extract: one adapter fires directly; several open the picker.
  let pickerOpen = $state(false)
  let reextractMsg = $state('')
  let reextracting = $state(false)

  function onReextractClick() {
    if (adapters.length > 1) {
      pickerOpen = true
    } else {
      void doReextract(adapters[0]?.id)
    }
  }

  async function doReextract(adapter?: string) {
    if (id == null) return
    pickerOpen = false
    reextracting = true
    reextractMsg = ''
    try {
      const res = await api.reextract(id, adapter !== undefined ? { adapter } : {})
      if (res.ok) {
        reextractMsg = 're-extract started'
        await queryClient.invalidateQueries({ queryKey: ['link', id] })
        await queryClient.invalidateQueries({ queryKey: ['links'] })
      } else {
        reextractMsg = res.reason ?? 're-extract rejected'
      }
    } catch (err) {
      reextractMsg = err instanceof ApiError ? err.message : String(err)
    } finally {
      reextracting = false
    }
  }

  // 'r' arrives via the bus: the link list owns the shortcut and asks the
  // preview pane (which owns the adapter picker) to re-extract its link.
  $effect(() => {
    return reextractBus.subscribe((busId) => {
      if (busId != null && busId === id) {
        reextractBus.set(null)
        onReextractClick()
      }
    })
  })

  const stateLine = $derived.by(() => {
    if (!detail) return ''
    const parts: string[] = []
    if (detail.state) parts.push(detail.state.replace(/_/g, ' '))
    const reason = detail.reason ?? detail.stateData?.reason ?? detail.stateData?.error
    if (reason) parts.push(reasonLabel(String(reason)))
    if (detail.next_attempt_at) parts.push(`retry ${timeAgo(detail.next_attempt_at)}`)
    if (detail.stateData?.stage) parts.push(`stage: ${detail.stateData.stage}`)
    if (detail.stateData?.retryable === false) parts.push("won't retry")
    return parts.join(' · ')
  })
</script>

{#if id == null}
  <div class="preview-empty">
    <p class="meta">Select a link to preview it.</p>
    <p class="meta-faint">j/k move · / search · a archive · s schedule · d discard</p>
  </div>
{:else if detailQuery.isPending}
  <div class="preview-body">
    <div class="skeleton" style="height: 120px;"></div>
    <div class="skeleton" style="height: 200px; margin-top: 12px;"></div>
  </div>
{:else if detailQuery.isError}
  <div class="preview-body">
    <div class="notice notice-bad" role="alert">
      Failed to load link #{id}.
      <button class="btn btn-sm" onclick={() => void detailQuery.refetch()}>retry</button>
    </div>
  </div>
{:else if detail}
  <div class="preview">
    <header class="preview-head">
      <div class="preview-url-row">
        <span class="preview-url mono" title={detail.url}>{truncate(detail.url, 90)}</span>
        <CopyButton text={detail.url} label="copy url" />
      </div>
      <h2 class="preview-title">{detail.title !== '' ? detail.title : detail.url}</h2>
      <div class="preview-state">
        <StateChip collection={collection} state={detail.state} />
        {#if stateLine}<span class="meta">{stateLine}</span>{/if}
      </div>
    </header>

    <nav class="tabbar" aria-label="Preview tabs">
      {#each PREVIEW_TABS as t, i (t)}
        <button
          type="button"
          class="tab"
          class:is-active={url.tab === t}
          class:is-dim={t === 'snapshot' || t === 'live'}
          data-testid="tab-{t}"
          onclick={() => setUrl({ tab: t })}
        >
          <span class="kbd">{i + 1}</span> {TAB_LABELS[t]}
          {#if t === 'live' && !frameable}<span class="meta-faint">snapshot</span>{/if}
        </button>
      {/each}
    </nav>

    <div class="preview-body scroll-thin" data-testid="preview-body">
      {#if url.tab === 'reader'}
        {#if detailQuery.isPending}
          <div class="skeleton" style="height: 160px;"></div>
        {:else if readerHtml !== ''}
          <article class="markdown-body" data-testid="reader-markdown">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
            {@html readerHtml}
          </article>
        {:else}
          <div class="notice notice-neutral">
            <p class="meta">No extraction yet.</p>
            <p class="meta-faint">
              This link hasn't been read — it is still pending or parked. The extracted
              markdown appears here after the extract stage runs.
            </p>
          </div>
        {/if}
      {:else if url.tab === 'metadata'}
        <section class="meta-pane" data-testid="metadata-pane">
          <h3 class="section-title">Enrichment</h3>
          <p class="meta-faint section-note">generated — re-extract to change</p>
          <dl class="facts">
            <div class="fact"><dt>category</dt><dd>{detail.category || '—'}</dd></div>
            <div class="fact"><dt>priority</dt><dd>{detail.priority}</dd></div>
            <div class="fact"><dt>read time</dt><dd>{detail.read_minutes > 0 ? `${detail.read_minutes} min` : '—'}</dd></div>
            <div class="fact"><dt>expires</dt><dd>{detail.expires_at ? `${timeAgo(detail.expires_at)}${detail.expiry_reason ? ` · ${detail.expiry_reason}` : ''}` : '—'}</dd></div>
            <div class="fact"><dt>confidence</dt><dd>{detail.confidence > 0 ? `${Math.round(detail.confidence * 100)}%` : '—'}</dd></div>
            <div class="fact fact-wide"><dt>why it matters</dt><dd>{detail.why_it_matters || '—'}</dd></div>
            {#each Object.entries(detail.enrichment ?? {}).filter(([k]) => !['why_it_matters'].includes(k)) as [k, val] (k)}
              <div class="fact"><dt>{k}</dt><dd>{typeof val === 'object' ? JSON.stringify(val) : String(val)}</dd></div>
            {/each}
          </dl>

          <h3 class="section-title">Your fields</h3>
          <p class="meta-faint section-note">title, note and tags — saved on blur</p>
          {#if metaForm}
            <div class="meta-form">
            <Form of={metaForm} onsubmit={onMetaSubmit} onfocusout={saveMetaBlur}>
              <label class="field">
                <span class="field-label">title</span>
                <Field of={metaForm} path={["title"]}>
                  {#snippet children(field)}
                    <input
                      class="input"
                      type="text"
                      value={String(field.input ?? '')}
                      oninput={(e) => field.onInput(e.currentTarget.value)}
                      data-testid="edit-title"
                    />
                  {/snippet}
                </Field>
              </label>
              <label class="field">
                <span class="field-label">note</span>
                <Field of={metaForm} path={["note"]}>
                  {#snippet children(field)}
                    <textarea
                      class="textarea"
                      rows="3"
                      value={String(field.input ?? '')}
                      oninput={(e) => field.onInput(e.currentTarget.value)}
                      data-testid="edit-note"
                    ></textarea>
                  {/snippet}
                </Field>
              </label>
              <label class="field">
                <span class="field-label">tags</span>
                <Field of={metaForm} path={["tags"]}>
                  {#snippet children(field)}
                    <input
                      class="input"
                      type="text"
                      value={String(field.input ?? '')}
                      oninput={(e) => field.onInput(e.currentTarget.value)}
                      data-testid="edit-tags"
                    />
                  {/snippet}
                </Field>
              </label>
              {#if metaError}<p class="field-error">{metaError}</p>{/if}
            </Form>
            </div>
          {/if}
          <div class="reextract-row">
            <button
              type="button"
              class="btn btn-sm"
              disabled={reextracting || adapters.length === 0}
              title={adapters.length === 0 ? 'no browser adapters configured' : undefined}
              onclick={onReextractClick}
              data-testid="reextract-button"
            >
              {reextracting ? 're-extracting…' : 'Re-extract with adapter…'}
            </button>
            {#if adapters.length === 0}
              <span class="meta-faint">no browser adapters configured</span>
            {:else if reextractMsg}
              <span class="meta">{reextractMsg}</span>
            {/if}
          </div>
        </section>
      {:else if url.tab === 'snapshot'}
        {#if snapshotMissing}
          <div class="notice notice-neutral" data-testid="snapshot-empty">
            <p class="meta">No snapshot captured.</p>
            <p class="meta-faint">A snapshot is written when the extractor captures the page — it appears here after the next extract.</p>
          </div>
        {:else}
          <img
            class="snapshot-img"
            src={api.artifactUrl(id, 'snapshot.png')}
            alt="Page snapshot"
            data-testid="snapshot-img"
            onerror={() => (snapshotMissing = true)}
          />
        {/if}
      {:else if url.tab === 'live'}
        {#if frameable && detail?.url}
          <figure class="live-fig">
            <iframe
              class="live-frame"
              src={detail.url}
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              title="Live page"
              data-testid="live-frame"
            ></iframe>
            <figcaption class="meta-faint">live — untrusted page</figcaption>
          </figure>
        {:else}
          <div class="live-fallback" data-testid="live-fallback">
            {#if !snapshotMissing}
              <img
                class="snapshot-img"
                src={api.artifactUrl(id, 'snapshot.png')}
                alt="Page snapshot"
                onerror={() => (snapshotMissing = true)}
              />
            {/if}
            <div class="notice notice-neutral">
              <p class="meta">This page isn't frameable{detail?.needsBrowser ? ' (it needs a login session)' : ''}.</p>
              <p class="meta-faint">Showing the last snapshot instead — there is no header-stripping proxy.</p>
              <button
                type="button"
                class="btn btn-sm"
                onclick={() => detail?.url && window.open(detail.url, '_blank', 'noopener')}
                data-testid="open-browser"
              >
                Open in browser
              </button>
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <footer class="action-bar">
      <div class="action-buttons">
        <button type="button" class="btn btn-sm" onclick={() => void act('archive')} data-testid="action-archive">
          <span class="kbd">a</span> archive
        </button>
        <button type="button" class="btn btn-sm" onclick={() => void act('schedule')} data-testid="action-schedule">
          <span class="kbd">s</span> schedule
        </button>
        <button type="button" class="btn btn-sm btn-danger" onclick={() => void act('discard')} data-testid="action-discard">
          <span class="kbd">d</span> discard
        </button>
        <button type="button" class="btn btn-sm" onclick={onReextractClick} data-testid="action-reextract">
          <span class="kbd">r</span> re-extract
        </button>
        <button
          type="button"
          class="btn btn-sm"
          onclick={() => detail?.url && window.open(detail.url, '_blank', 'noopener')}
          data-testid="action-open"
        >
          <span class="kbd">o</span> open
        </button>
      </div>
      <div class="key-hints meta-faint">
        <span class="kbd">1</span>–<span class="kbd">4</span> tabs
        <span class="kbd">j</span>/<span class="kbd">k</span> move
        <span class="kbd">/</span> search
        <span class="kbd">?</span> keys
      </div>
    </footer>

  </div>
{/if}

<Dialog open={pickerOpen} labelledBy="adapter-picker-title" onClose={() => (pickerOpen = false)}>
  <div class="picker">
    <h2 id="adapter-picker-title" class="picker-title">Re-extract with adapter</h2>
    <p class="meta">Pick the browser adapter for link #{id}.</p>
    <div class="picker-list">
      {#each adapters as a (a.id)}
        <button
          type="button"
          class="list-row"
          onclick={() => void doReextract(a.id)}
          data-testid="adapter-{a.id}"
        >
          <span class="row-main">
            <span class="adapter-id mono">{a.id}</span>
            <span class="meta">
              {a.kind}{a.roles.length ? ` · ${a.roles.join('+')}` : ''}
              {a.health.ok ? ' · healthy' : ` · ${a.health.detail}`}
            </span>
          </span>
        </button>
      {/each}
    </div>
    <div class="picker-foot">
      <button type="button" class="btn btn-sm" onclick={() => (pickerOpen = false)}>cancel</button>
    </div>
  </div>
</Dialog>

<style>
  .preview-empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  .preview {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .preview-head {
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--color-line);
  }
  .preview-url-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .preview-url {
    font-size: 11.5px;
    color: var(--color-ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .preview-title {
    font-size: 17px;
    margin-top: 6px;
    line-height: 1.3;
  }
  .preview-state {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .preview-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px;
  }
  .meta-pane {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .section-title {
    font-size: 14px;
    margin-top: 14px;
  }
  .section-note {
    margin-bottom: 6px;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 18px;
    margin: 0;
  }
  .fact {
    display: flex;
    gap: 8px;
    font-size: 12.5px;
  }
  .fact dt {
    color: var(--color-ink-faint);
    min-width: 90px;
    flex: none;
  }
  .fact dd {
    margin: 0;
    color: var(--color-ink);
  }
  .fact-wide {
    grid-column: 1 / -1;
  }
  .meta-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-ink-soft);
  }
  .field-error {
    color: var(--color-state-blocked);
    font-size: 12px;
  }
  .reextract-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .snapshot-img {
    max-width: 100%;
    border-radius: 8px;
    border: 1px solid var(--color-line);
    display: block;
  }
  .live-fig {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .live-frame {
    width: 100%;
    height: 420px;
    border: 1px solid var(--color-line-strong);
    border-radius: 8px;
    background: var(--color-surface);
  }
  .live-fallback {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .action-bar {
    border-top: 1px solid var(--color-line);
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .action-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .key-hints {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .picker {
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .picker-title {
    font-size: 16px;
  }
  .picker-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 300px;
    overflow-y: auto;
  }
  .adapter-id {
    font-size: 13px;
    font-weight: 600;
  }
  .picker-foot {
    display: flex;
    justify-content: flex-end;
  }
  .preview-body {
    position: relative;
  }
</style>
