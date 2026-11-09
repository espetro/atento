<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import * as v from 'valibot'
  import { createForm, Form, Field, type FormStore } from '@formisch/svelte'
  import { api, ApiError } from '../lib/api'
  import { sseIngestJobs } from '../lib/events'
  import type { IngestJob, IngestJobSummary } from '../lib/types'
  import Dialog from '../lib/components/Dialog.svelte'
  import CopyButton from '../lib/components/CopyButton.svelte'
  import IconX from '~icons/lucide/x'
  import { m } from '../paraglide/messages.js'
  import type { UrlState } from '../lib/urlState'

  let {
    open,
    setUrl,
  }: {
    open: boolean
    setUrl: (next: Partial<UrlState>) => void
  } = $props()

  const queryClient = useQueryClient()

  const MAX_URLS = 500
  const ACCEPT = '.md,.markdown,.txt,.html,.htm,.json,.jsonl,.csv'
  const FILE_MAX_BYTES = 10 * 1024 * 1024

  // ---- valibot schemas (formisch fields for paste mode; file checked on pick)
  const URL_RE = /https?:\/\/[^\s)\]}>"']+/g
  const MD_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g

  function detectUrls(text: string): string[] {
    const urls = new Set<string>()
    let m: RegExpExecArray | null
    URL_RE.lastIndex = 0
    MD_RE.lastIndex = 0
    while ((m = URL_RE.exec(text)) !== null) urls.add(m[0].replace(/[.,;:!?]+$/, ''))
    while ((m = MD_RE.exec(text)) !== null) urls.add(m[1]!)
    return [...urls]
  }

  const pasteSchema = v.object({
    text: v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(m.val_paste_required()),
      v.check(
        (t) => detectUrls(t).length <= MAX_URLS,
        m.val_too_many_urls({ max: MAX_URLS }),
      ),
    ),
    note: v.string(),
    tags: v.string(),
  })
  type PasteForm = v.InferInput<typeof pasteSchema>

  const fileSchema = v.pipe(
    v.custom<File>((i) => i instanceof File, m.val_choose_file()),
    v.check((f) => f.size <= FILE_MAX_BYTES, m.val_file_too_large()),
    v.check(
      (f) => /\.(md|markdown|txt|html?|jsonl?|csv)$/i.test(f.name),
      m.val_file_type(),
    ),
  )

  type PasteSchema = typeof pasteSchema
  let pasteForm = $state<FormStore<PasteSchema> | null>(null)
  $effect(() => {
    if (mode !== 'paste' || job != null) return
    pasteForm = createForm({
      schema: pasteSchema,
      initialInput: { text, note, tags: tagsInput },
    })
  })

  type Mode = 'paste' | 'file'
  let mode = $state<Mode>('paste')
  let text = $state('')
  let note = $state('')
  let tagsInput = $state('')
  let file = $state<File | null>(null)
  let dragOver = $state(false)
  let submitting = $state(false)
  let submitError = $state('')

  // ---- job progress ---------------------------------------------------------
  let job = $state<IngestJobSummary | null>(null)
  let liveJob = $state<IngestJob | null>(null)
  let warningsOpen = $state(false)
  let warningsAll = $state(false)

  const sseJobs = sseIngestJobs // store; subscribed below
  $effect(() => {
    const unsub = sseJobs.subscribe((map) => {
      if (!job) return
      const j = map.get(job.jobId)
      if (j) liveJob = j
    })
    return unsub
  })

  // Polling fallback while the job is non-terminal (SSE is primary).
  let pollTimer: ReturnType<typeof setInterval> | undefined
  $effect(() => {
    if (!job || !open) return
    const status = liveJob?.status ?? job.status
    if (status === 'done' || status === 'failed') return
    pollTimer = setInterval(() => {
      void api
        .ingestJob(job!.jobId)
        .then((r) => (liveJob = r.job))
        .catch(() => {})
    }, 1000)
    return () => clearInterval(pollTimer)
  })

  const effectiveJob = $derived<IngestJob | null>(liveJob)
  const status = $derived<IngestJobSummary['status']>(
    effectiveJob ? effectiveJob.status : (job?.status ?? 'pending'),
  )
  const done = $derived(effectiveJob?.done ?? 0)
  const total = $derived(effectiveJob?.total ?? job?.accepted ?? 0)
  const pct = $derived(total > 0 ? Math.round((done / total) * 100) : 0)

  // Detect urls + markdown links in the paste buffer.
  const detected = $derived.by(() => {
    const urls = new Set<string>()
    const urlRe = /https?:\/\/[^\s)\]>"']+/g
    const mdRe = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
    let m: RegExpExecArray | null
    while ((m = urlRe.exec(text)) !== null) urls.add(m[0].replace(/[.,;:!?]+$/, ''))
    while ((m = mdRe.exec(text)) !== null) urls.add(m[1]!)
    return [...urls]
  })
  const hasMarkdown = $derived(hasMarkdownText(text))
  const overLimit = $derived(detected.length > MAX_URLS)

  function close() {
    // Closing never cancels a durable job — it only detaches the view.
    job = null
    liveJob = null
    submitError = ''
    setUrl({ dialog: '' })
  }

  // The last body we POSTed — Retry re-sends it verbatim (file mode rebuilds
  // the FormData from the stored File since FormData is single-use here).
  let lastBody = $state<Parameters<typeof api.ingest>[0] | null>(null)
  let lastFile = $state<File | null>(null)

  async function doIngest(body: Parameters<typeof api.ingest>[0]) {
    submitError = ''
    submitting = true
    lastBody = body
    try {
      const summary = await api.ingest(body)
      job = summary
      liveJob = null
      void queryClient.invalidateQueries({ queryKey: ['links'] })
      void queryClient.invalidateQueries({ queryKey: ['collections-summary'] })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Busy: the body still parses as a summary with busy info.
        const busyBody = err.body as Partial<IngestJobSummary> | null
        job = {
          jobId: busyBody?.jobId ?? '',
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          status: 'busy',
          warnings: [],
          busy: busyBody?.busy ?? null,
        }
      } else {
        submitError = err instanceof ApiError ? err.message : String(err)
      }
    } finally {
      submitting = false
    }
  }

  function buildPasteBody(output: PasteForm) {
    const t = output.text.trim()
    const urls = detectUrls(t)
    const isPureList =
      urls.length > 0 && !hasMarkdownText(t) && urls.join('') === t.replace(/\s+/g, '')
    const note_ = output.note.trim()
    const tags = output.tags
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    if (isPureList) {
      return {
        kind: 'urls' as const,
        urls,
        ...(note_ ? { note: note_ } : {}),
        ...(tags.length ? { tags } : {}),
      }
    }
    return { kind: 'text' as const, text: t }
  }

  function hasMarkdownText(t: string): boolean {
    return /\[[^\]]*\]\(https?:/.test(t) || /[^\s]+\.(md|markdown|txt|html?)\b/i.test(t)
  }

  function onPasteSubmit(output: PasteForm) {
    void doIngest(buildPasteBody(output))
  }

  async function submitFile() {
    submitError = ''
    const parsed = v.safeParse(fileSchema, file)
    if (!parsed.success) {
      submitError = parsed.issues[0]?.message ?? m.ingest_invalid_file()
      return
    }
    const f = parsed.output
    const fd = new FormData()
    fd.append('file', f, f.name)
    lastFile = f
    await doIngest(fd)
  }

  async function retryLast() {
    if (!lastBody && !lastFile) return
    job = null
    liveJob = null
    if (lastBody) {
      await doIngest(lastBody)
    } else if (lastFile) {
      const fd = new FormData()
      fd.append('file', lastFile, lastFile.name)
      await doIngest(fd)
    }
  }

  function onFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    file = input.files?.[0] ?? null
    submitError = ''
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const f = e.dataTransfer?.files?.[0]
    if (f) {
      mode = 'file'
      file = f
      submitError = ''
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (submitting || job != null) return
      if (mode === 'file') {
        void submitFile()
      } else {
        document.querySelector<HTMLFormElement>('[data-testid=ingest-form]')?.requestSubmit()
      }
    }
  }

  const warnings = $derived(job?.warnings ?? [])
  const visibleWarnings = $derived(warningsAll ? warnings : warnings.slice(0, 5))
</script>

<Dialog {open} labelledBy="ingest-title" onClose={close} initialFocus="[data-testid=ingest-textarea]">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="ingest-dialog" role="group" aria-label={m.ingest_title()} onkeydown={onKeydown} data-testid="ingest-dialog">
    <header class="ingest-head">
      <h2 id="ingest-title" class="ingest-title">{m.ingest_title()}</h2>
      <button type="button" class="btn btn-ghost btn-icon" aria-label={m.aria_close()} onclick={close}><IconX /></button>
    </header>

    {#if job == null}
      <div class="mode-tabs" role="tablist" aria-label={m.ingest_mode_aria()}>
        <button
          type="button"
          class="mode-tab"
          class:is-active={mode === 'paste'}
          role="tab"
          aria-selected={mode === 'paste'}
          onclick={() => (mode = 'paste')}
        >{m.ingest_mode_paste()}</button>
        <button
          type="button"
          class="mode-tab"
          class:is-active={mode === 'file'}
          role="tab"
          aria-selected={mode === 'file'}
          onclick={() => (mode = 'file')}
        >{m.ingest_mode_file()}</button>
      </div>

      {#if mode === 'paste'}
        {#if pasteForm}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <Form of={pasteForm} onsubmit={onPasteSubmit} class="ingest-form" data-testid="ingest-form">
            <Field of={pasteForm} path={["text"]}>
              {#snippet children(field)}
                <textarea
                  class="textarea ingest-text"
                  rows="10"
                  placeholder={m.ingest_placeholder()}
                  aria-label={m.ingest_textarea_aria()}
                  value={String(field.input ?? '')}
                  oninput={(e) => {
                    field.onInput(e.currentTarget.value)
                    text = e.currentTarget.value
                  }}
                  data-testid="ingest-textarea"
                ></textarea>
                {#if field.errors}<p class="field-error" role="alert">{field.errors[0]}</p>{/if}
              {/snippet}
            </Field>
            <p class="meta ingest-hint">
              {m.ingest_hint({ max: MAX_URLS })}
              {#if detected.length > 0}
                · <strong data-testid="url-count">{m.ingest_urls_detected({ count: detected.length })}</strong>
              {/if}
            </p>
            {#if overLimit}
              <p class="notice notice-bad" role="alert" data-testid="over-limit">
                {m.ingest_over_limit({ count: detected.length, max: MAX_URLS })}
              </p>
            {/if}
            <div class="field-row">
              <label class="field">
                <span class="field-label">{m.ingest_note_label()}</span>
                <Field of={pasteForm} path={["note"]}>
                  {#snippet children(field)}
                    <input
                      class="input"
                      type="text"
                      value={String(field.input ?? '')}
                      oninput={(e) => {
                        field.onInput(e.currentTarget.value)
                        note = e.currentTarget.value
                      }}
                      placeholder={m.ingest_note_placeholder()}
                    />
                  {/snippet}
                </Field>
              </label>
              <label class="field">
                <span class="field-label">{m.ingest_tags_label()}</span>
                <Field of={pasteForm} path={["tags"]}>
                  {#snippet children(field)}
                    <input
                      class="input"
                      type="text"
                      value={String(field.input ?? '')}
                      oninput={(e) => {
                        field.onInput(e.currentTarget.value)
                        tagsInput = e.currentTarget.value
                      }}
                      placeholder={m.ingest_tags_placeholder()}
                    />
                  {/snippet}
                </Field>
              </label>
            </div>
            {#if submitError}
              <p class="notice notice-bad" role="alert" data-testid="ingest-error">{submitError}</p>
            {/if}
            <footer class="ingest-foot">
              <button type="button" class="btn" onclick={close}>{m.ingest_cancel()}</button>
              <button
                type="submit"
                class="btn btn-primary"
                disabled={submitting || overLimit}
                data-testid="ingest-submit"
              >
                {submitting ? m.ingest_busy() : detected.length > 0 ? (detected.length === 1 ? m.ingest_submit_one({ count: detected.length }) : m.ingest_submit_other({ count: detected.length })) : m.ingest_submit()}
              </button>
            </footer>
          </Form>
        {/if}
      {:else}
        <div
          class="dropzone"
          class:drag-over={dragOver}
          role="button"
          tabindex="0"
          ondragover={(e) => {
            e.preventDefault()
            dragOver = true
          }}
          ondragleave={() => (dragOver = false)}
          ondrop={onDrop}
          data-testid="ingest-dropzone"
        >
          {#if file}
            <p class="drop-file">{file.name} <span class="meta">({Math.ceil(file.size / 1024)} KB)</span></p>
          {:else}
            <p class="meta">{m.dropzone_hint()}</p>
          {/if}
          <label class="btn btn-sm">
            {m.dropzone_choose()}
            <input
              type="file"
              accept={ACCEPT}
              class="sr-only"
              onchange={onFileInput}
              data-testid="ingest-file-input"
            />
          </label>
          <p class="meta">{m.dropzone_types()}</p>
        </div>
      {/if}

      {#if mode === 'file'}
        {#if submitError}
          <p class="notice notice-bad" role="alert" data-testid="ingest-error">{submitError}</p>
        {/if}

        <footer class="ingest-foot">
          <button type="button" class="btn" onclick={close}>{m.ingest_cancel()}</button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={submitting || file == null}
            onclick={() => void submitFile()}
            data-testid="ingest-submit"
          >
            {submitting ? m.ingest_busy() : m.ingest_submit()}
          </button>
        </footer>
      {/if}
    {:else}
      <!-- progress / result state -->
      <div class="job-view" data-testid="ingest-job">
        {#if status === 'busy'}
          <p class="notice notice-warn" role="status">
            {m.ingest_busy_notice()}{job.busy?.pid != null ? ` (pid ${job.busy.pid})` : ''}
            {#if job.busy?.runId != null}· {m.ingest_busy_run({ runId: job.busy.runId })}{/if}
          </p>
          <footer class="ingest-foot">
            <button type="button" class="btn" onclick={close}>{m.ingest_close()}</button>
          </footer>
        {:else}
          <p class="job-line meta">
            {m.ingest_job_line({ id: job.jobId || '—', status })}
          </p>
          {#if status !== 'failed'}
            <div
              class="progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax={total || 1}
              aria-valuenow={done}
              aria-label={m.ingest_progress_aria()}
            >
              <div class="progress-fill" style={`width: ${pct}%`}></div>
            </div>
            <p class="meta">{m.ingest_progress_line({ done, total, pct })}</p>
          {/if}

          {#if status === 'failed'}
            <p class="notice notice-bad" role="alert" data-testid="ingest-failed">
              {effectiveJob?.error ?? m.ingest_failed_fallback()}
            </p>
            <footer class="ingest-foot">
              <button type="button" class="btn" onclick={close}>{m.ingest_close()}</button>
              <button
                type="button"
                class="btn btn-primary"
                disabled={submitting || (lastBody == null && lastFile == null)}
                onclick={() => void retryLast()}
                data-testid="ingest-retry"
              >
                {submitting ? m.ingest_retrying() : m.action_retry()}
              </button>
            </footer>
          {:else if status === 'done'}
            <p class="job-summary" data-testid="ingest-summary">
              {m.ingest_counters({ accepted: job.accepted, duplicates: job.duplicates, rejected: job.rejected })}
            </p>
            {#each job.warnings as w, i (i)}
              <p class="meta warning-line">{w}</p>
            {/each}
            <footer class="ingest-foot">
              <button
                type="button"
                class="btn btn-sm"
                onclick={() => {
                  close()
                  setUrl({ view: 'triage', collection: 'pending', selected: null })
                }}
              >{m.ingest_view_pending()}</button>
              <button type="button" class="btn btn-primary" onclick={close}>{m.action_done()}</button>
            </footer>
          {:else}
            <p class="job-summary meta" data-testid="ingest-counters">
              {m.ingest_counters({ accepted: job.accepted, duplicates: job.duplicates, rejected: job.rejected })}
            </p>
            {#if visibleWarnings.length > 0}
              <div class="warnings">
                {#each visibleWarnings as w, i (i)}
                  <p class="meta warning-line">{w}</p>
                {/each}
                {#if !warningsAll && warnings.length > 5}
                  <button type="button" class="chip chip-button" onclick={() => (warningsAll = true)}>
                    {m.warnings_more({ count: warnings.length - 5 })}
                  </button>
                {/if}
              </div>
            {/if}
            <footer class="ingest-foot">
              <span class="spacer"></span>
              <CopyButton text={job.jobId} label={m.copy_job_id()} />
              <button type="button" class="btn" onclick={close}>{m.ingest_close()}</button>
            </footer>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</Dialog>

<style>
  .ingest-dialog {
    width: min(560px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .ingest-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ingest-title {
    font-size: 17px;
  }
  .mode-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--color-line);
  }
  .mode-tab {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--color-ink-soft);
    border-bottom: 2px solid transparent;
    background: none;
    cursor: pointer;
  }
  .mode-tab.is-active {
    color: var(--color-ink);
    border-bottom-color: var(--color-accent);
    font-weight: 600;
  }
  .ingest-text {
    width: 100%;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
  }
  .ingest-hint {
    margin-top: -4px;
  }
  .field-row {
    display: flex;
    gap: 10px;
  }
  .field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 12px;
    color: var(--color-ink-soft);
  }
  .dropzone {
    border: 1.5px dashed var(--color-line);
    border-radius: 10px;
    padding: 28px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
    cursor: pointer;
  }
  .dropzone.drag-over {
    border-color: var(--color-accent);
    background: var(--color-accent-soft, rgba(0, 0, 0, 0.03));
  }
  .drop-file {
    font-weight: 600;
    font-size: 14px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .ingest-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    align-items: center;
  }
  .job-view {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .job-line {
    font-size: 13px;
  }
  .progress {
    height: 8px;
    border-radius: 4px;
    background: var(--color-line);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.3s ease;
  }
  .job-summary {
    font-size: 13.5px;
    font-weight: 600;
  }
  .warnings {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 90px;
    overflow-y: auto;
  }
  .field-error {
    font-size: 12px;
    color: var(--color-bad, #b91c1c);
    margin: 4px 0 0;
  }
  .warning-line {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
</style>
