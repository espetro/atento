<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import * as v from 'valibot'
  import { createForm, Form, Field, type FormStore } from '@formisch/svelte'
  import { api, ApiError } from '../lib/api'
  import { reextractBus } from '../lib/events'
  import { density } from '../lib/prefs'
  import { timeAgo, truncate } from '../lib/format'
  import { reasonLabel } from '../lib/copy'
  import type { LinkAction, LinkDetail } from '../lib/types'
  import StateChip from '../components/StateChip.svelte'
  import CopyButton from '../components/CopyButton.svelte'
  import Dialog from '../components/Dialog.svelte'
  import NativePreview from '../components/NativePreview.svelte'
  import { hasShellBridge, isDesktopShell, linkMenuItems, showShellContextMenu } from '../lib/desktop'
  import { copyText } from '../lib/format'
  import IconEllipsis from '~icons/lucide/ellipsis'
  import { m } from '../paraglide/messages.js'

  let {
    id,
    onTriage,
    collection,
  }: {
    id: number | null
    onTriage: (ids: number[], action: LinkAction) => Promise<void>
    collection: string
  } = $props()

  const queryClient = useQueryClient()

  // Desktop shell (B1): inside Electrobun the preview slot hosts a real
  // native webview; on plain web this stays false and the reader/snapshot
  // fallback below renders exactly as before.
  const nativePreview = isDesktopShell()

  const detailQuery = createQuery(() => ({
    queryKey: ['link', id],
    queryFn: () => api.link(id!),
    enabled: id != null,
    // Desktop only: keep the previous link's detail while the next one
    // fetches. Without it the preview (and its pooled webviews) unmounts on
    // every selection change, defeating the warm pool. Web behavior is
    // unchanged — placeholderData stays undefined there.
    placeholderData: nativePreview ? (prev: LinkDetail | undefined) => prev : undefined,
  }))

  const detail = $derived<LinkDetail | null>(detailQuery.data ?? null)

  // Browsers for the re-extract adapter picker.
  const browsersQuery = createQuery(() => ({
    queryKey: ['browsers'],
    queryFn: () => api.browsers(),
    staleTime: 30_000,
  }))
  const adapters = $derived(browsersQuery.data?.adapters ?? [])

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
  // Recreate the form only when the selected link changes — an SSE-driven
  // detail refetch must not wipe in-progress edits.
  let metaFormLinkId: number | null = null
  $effect(() => {
    if (!detail || id == null || id === metaFormLinkId) return
    metaFormLinkId = id
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
        reextractMsg = m.reextract_started()
        await queryClient.invalidateQueries({ queryKey: ['link', id] })
        await queryClient.invalidateQueries({ queryKey: ['links'] })
      } else {
        reextractMsg = res.reason ?? m.reextract_rejected()
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

  // Desktop shell: right-click shows the native context menu with the same
  // actions the footer section used to carry (the section is hidden there).
  function onPaneContextMenu(e: MouseEvent) {
    if (!hasShellBridge() || detail == null) return
    e.preventDefault()
    void showShellContextMenu(linkMenuItems(detail))
  }

  // ---- actions overflow (⋯) -------------------------------------------------
  // Progressive disclosure (P1.2): actions moved from an always-visible
  // footer into a menu. Desktop gets the native context menu; web gets a
  // dropdown. Both surfaces now expose menus, not buttons.
  let overflowOpen = $state(false)

  function onOverflowClick(e: MouseEvent) {
    e.stopPropagation()
    if (detail == null) return
    if (hasShellBridge()) {
      void showShellContextMenu(linkMenuItems(detail))
      return
    }
    overflowOpen = !overflowOpen
  }

  $effect(() => {
    if (!overflowOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        overflowOpen = false
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function overflowRun(fn: () => void) {
    overflowOpen = false
    fn()
  }

  const stateLine = $derived.by(() => {
    if (!detail) return ''
    const parts: string[] = []
    if (detail.state) parts.push(detail.state.replace(/_/g, ' '))
    const reason = detail.reason ?? detail.stateData?.reason ?? detail.stateData?.error
    if (reason) parts.push(reasonLabel(String(reason)))
    if (detail.next_attempt_at) parts.push(m.row_retry({ time: timeAgo(detail.next_attempt_at) }))
    if (detail.stateData?.stage) parts.push(m.state_stage({ stage: String(detail.stateData.stage) }))
    if (detail.stateData?.retryable === false) parts.push(m.state_wont_retry())
    return parts.join(' · ')
  })
</script>

{#if id == null}
  <div class="preview-empty">
    <p class="meta">{m.preview_select_hint()}</p>
    <p class="meta-faint">{m.preview_shortcuts_hint()}</p>
  </div>
{:else if detailQuery.isPending}
  <div class="preview-body">
    <div class="skeleton" style="height: 120px;"></div>
    <div class="skeleton" style="height: 200px; margin-top: 12px;"></div>
  </div>
{:else if detailQuery.isError}
  <div class="preview-body">
    <div class="notice notice-bad" role="alert">
      {m.preview_load_error({ id })}
      <button class="btn btn-sm" onclick={() => void detailQuery.refetch()}>{m.action_retry()}</button>
    </div>
  </div>
{:else if detail}
  <!-- One scrollable panel: preview → metadata → actions (A2). The old
       reader/metadata/snapshot/live tab bar is gone; the live iframe was
       dropped (X-Frame-Options makes it useless). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="preview" class:density-compact={$density === 'compact'} data-testid="preview-pane" oncontextmenu={onPaneContextMenu}>
    <header class="preview-head">
      <div class="preview-url-row">
        <span class="preview-url mono" title={detail.url}>{truncate(detail.url, 90)}</span>
        <CopyButton text={detail.url} label={m.action_copy_url()} />
        <div class="overflow-wrap">
          <button
            type="button"
            class="btn btn-ghost btn-icon overflow-btn"
            aria-label={m.section_actions()}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onclick={onOverflowClick}
            data-testid="overflow-actions"
          >
            <IconEllipsis />
          </button>
          {#if overflowOpen}
            <div class="overflow-menu" role="menu" data-testid="overflow-menu">
              <button type="button" role="menuitem" class="overflow-item" onclick={() => overflowRun(() => detail.url && window.open(detail.url, '_blank', 'noopener'))}>
                {m.action_open()}
              </button>
              <hr class="overflow-sep" />
              <button type="button" role="menuitem" class="overflow-item" onclick={() => overflowRun(() => void act('archive'))} data-testid="action-archive">
                {m.action_archive()}
              </button>
              <button type="button" role="menuitem" class="overflow-item" onclick={() => overflowRun(() => void act('schedule'))}>
                {m.action_schedule()}
              </button>
              <button type="button" role="menuitem" class="overflow-item overflow-danger" onclick={() => overflowRun(() => void act('discard'))}>
                {m.action_discard()}
              </button>
              <hr class="overflow-sep" />
              <button type="button" role="menuitem" class="overflow-item" onclick={() => overflowRun(onReextractClick)}>
                {m.action_reextract()}
              </button>
              <button type="button" role="menuitem" class="overflow-item" onclick={() => overflowRun(() => void copyText(detail.url))}>
                {m.action_copy_url()}
              </button>
            </div>
          {/if}
        </div>
      </div>
      {#if overflowOpen}
        <!-- Click-outside dismissal: a transparent layer under the menu. -->
        <button type="button" class="overflow-backdrop" aria-label={m.aria_close()} onclick={() => (overflowOpen = false)} tabindex="-1"></button>
      {/if}
      <h2 class="preview-title">{detail.title !== '' ? detail.title : detail.url}</h2>
      <div class="preview-state">
        <StateChip collection={collection} state={detail.state} />
        {#if stateLine}<span class="meta">{stateLine}</span>{/if}
      </div>
    </header>

    <div class="preview-body scroll-thin" data-testid="preview-body">
      <section class="panel-section" data-testid="section-preview">
        {#if nativePreview && detail.url !== ''}
          <NativePreview url={detail.url} />
        {:else if readerHtml !== ''}
          <article class="markdown-body" data-testid="reader-markdown">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
            {@html readerHtml}
          </article>
        {:else if !snapshotMissing}
          <img
            class="snapshot-img"
            src={api.artifactUrl(id, 'snapshot.png')}
            alt={m.snapshot_alt()}
            data-testid="snapshot-img"
            onerror={() => (snapshotMissing = true)}
          />
        {:else}
          <div class="notice notice-neutral" data-testid="preview-empty-state">
            <p class="meta">{m.preview_none_title()}</p>
            <p class="meta-faint">
              {m.preview_none_body()}
            </p>
          </div>
        {/if}
      </section>

      <section class="panel-section" data-testid="metadata-pane">
        <h3 class="section-title">{m.section_enrichment()}</h3>
        <p class="meta-faint section-note">{m.enrichment_note()}</p>
        <dl class="facts">
          <div class="fact"><dt>{m.fact_category()}</dt><dd>{detail.category || '—'}</dd></div>
          <div class="fact"><dt>{m.fact_priority()}</dt><dd>{detail.priority}</dd></div>
          <div class="fact"><dt>{m.fact_read_time()}</dt><dd>{detail.read_minutes > 0 ? `${detail.read_minutes} min` : '—'}</dd></div>
          <div class="fact"><dt>{m.fact_expires()}</dt><dd>{detail.expires_at ? `${timeAgo(detail.expires_at)}${detail.expiry_reason ? ` · ${detail.expiry_reason}` : ''}` : '—'}</dd></div>
          <div class="fact"><dt>{m.fact_confidence()}</dt><dd>{detail.confidence > 0 ? `${Math.round(detail.confidence * 100)}%` : '—'}</dd></div>
          <div class="fact fact-wide"><dt>{m.fact_why()}</dt><dd>{detail.why_it_matters || '—'}</dd></div>
          {#each Object.entries(detail.enrichment ?? {}).filter(([k]) => !['why_it_matters'].includes(k)) as [k, val] (k)}
            <div class="fact"><dt>{k}</dt><dd>{typeof val === 'object' ? JSON.stringify(val) : String(val)}</dd></div>
          {/each}
        </dl>

        <h3 class="section-title">{m.section_your_fields()}</h3>
        <p class="meta-faint section-note">{m.your_fields_note()}</p>
        {#if metaForm}
          <div class="meta-form">
          <Form of={metaForm} onsubmit={onMetaSubmit} onfocusout={saveMetaBlur}>
            <label class="field">
              <span class="field-label">{m.field_title()}</span>
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
              <span class="field-label">{m.field_note()}</span>
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
              <span class="field-label">{m.field_tags()}</span>
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
            title={adapters.length === 0 ? m.no_adapters() : undefined}
            onclick={onReextractClick}
            data-testid="reextract-button"
          >
            {reextracting ? m.reextract_busy() : m.reextract_button()}
          </button>
          {#if adapters.length === 0}
            <span class="meta-faint">{m.no_adapters()}</span>
          {:else if reextractMsg}
            <span class="meta">{reextractMsg}</span>
          {/if}
        </div>
      </section>

    </div>
  </div>
{/if}

<Dialog open={pickerOpen} labelledBy="adapter-picker-title" onClose={() => (pickerOpen = false)}>
  <div class="picker">
    <h2 id="adapter-picker-title" class="picker-title">{m.picker_title()}</h2>
    <p class="meta">{m.picker_subtitle({ id: id ?? 0 })}</p>
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
              {a.health.ok ? ` · ${m.adapter_healthy()}` : ` · ${a.health.detail}`}
            </span>
          </span>
        </button>
      {/each}
    </div>
    <div class="picker-foot">
      <button type="button" class="btn btn-sm" onclick={() => (pickerOpen = false)}>{m.action_cancel()}</button>
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
    padding: 14px 16px 20px;
  }
  /* Panel sections stack inside the single scroll area. */
  .panel-section {
    padding-block: 4px 14px;
  }
  .panel-section + .panel-section {
    border-top: 1px solid var(--color-line);
    padding-top: 14px;
  }
  .density-compact .preview-body {
    padding: 10px 14px 16px;
  }
  .density-compact .panel-section {
    padding-block: 2px 10px;
  }
  .density-compact .panel-section + .panel-section {
    padding-top: 10px;
  }
  .density-compact .preview-head {
    padding: 10px 14px 8px;
  }
  .density-compact .preview-title {
    font-size: 15.5px;
  }
  .section-title {
    font-size: 14px;
    margin-top: 14px;
  }
  .panel-section > .section-title:first-child {
    margin-top: 0;
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
  .overflow-wrap {
    position: relative;
    flex: none;
  }
  .overflow-btn {
    color: var(--color-ink-soft);
  }
  .overflow-backdrop {
    position: fixed;
    inset: 0;
    z-index: 54;
    background: transparent;
    border: none;
    cursor: default;
  }
  .overflow-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 55;
    min-width: 160px;
    padding: 5px;
    border-radius: 10px;
    border: 1px solid var(--color-line);
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-pop, 0 8px 24px rgb(0 0 0 / 0.12));
    display: flex;
    flex-direction: column;
  }
  .overflow-item {
    border: none;
    background: transparent;
    text-align: left;
    padding: 7px 10px;
    border-radius: 7px;
    font-size: 13px;
    color: var(--color-ink);
    cursor: pointer;
    white-space: nowrap;
  }
  .overflow-item:hover,
  .overflow-item:focus-visible {
    background: var(--color-surface-sunken, rgb(0 0 0 / 0.05));
    outline: none;
  }
  .overflow-danger {
    color: var(--color-state-blocked);
  }
  .overflow-sep {
    border: none;
    border-top: 1px solid var(--color-line);
    margin: 4px 6px;
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
</style>
