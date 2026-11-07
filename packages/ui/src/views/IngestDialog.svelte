<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api, ApiError } from '../lib/api'
  import { sseIngestJobs } from '../lib/events'
  import type { IngestJob, IngestJobSummary } from '../lib/types'
  import Dialog from '../components/Dialog.svelte'
  import CopyButton from '../components/CopyButton.svelte'
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
  const hasMarkdown = $derived(/\[[^\]]*\]\(https?:/.test(text) || /[^\s]+\.(md|markdown|txt|html?)\b/i.test(text))
  const overLimit = $derived(detected.length > MAX_URLS)

  function close() {
    // Closing never cancels a durable job — it only detaches the view.
    job = null
    liveJob = null
    submitError = ''
    setUrl({ dialog: '' })
  }

  async function submit() {
    submitError = ''
    submitting = true
    try {
      let body: Parameters<typeof api.ingest>[0]
      if (mode === 'file') {
        if (!file) {
          submitError = 'choose a file first'
          return
        }
        const fd = new FormData()
        fd.append('file', file, file.name)
        body = fd
      } else if (detected.length > 0 && !hasMarkdown && detected.join('') === text.replace(/\s+/g, '')) {
        // pure url list -> kind:'urls'
        body = {
          kind: 'urls',
          urls: detected,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(tagsInput.trim()
            ? { tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean) }
            : {}),
        }
      } else {
        body = { kind: 'text', text }
      }
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
      if (!submitting && job == null) void submit()
    }
  }

  const warnings = $derived(liveJob ? [] : (job?.warnings ?? []))
  const visibleWarnings = $derived(warningsAll ? warnings : warnings.slice(0, 5))
</script>

<Dialog {open} labelledBy="ingest-title" onClose={close}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="ingest-dialog" role="group" aria-label="Ingest links" onkeydown={onKeydown} data-testid="ingest-dialog">
    <header class="ingest-head">
      <h2 id="ingest-title" class="ingest-title">Ingest links</h2>
      <button type="button" class="btn btn-ghost btn-icon" aria-label="Close" onclick={close}>✕</button>
    </header>

    {#if job == null}
      <div class="mode-tabs" role="tablist" aria-label="Ingest mode">
        <button
          type="button"
          class="mode-tab"
          class:is-active={mode === 'paste'}
          role="tab"
          aria-selected={mode === 'paste'}
          onclick={() => (mode = 'paste')}
        >Paste URLs / text</button>
        <button
          type="button"
          class="mode-tab"
          class:is-active={mode === 'file'}
          role="tab"
          aria-selected={mode === 'file'}
          onclick={() => (mode = 'file')}
        >Upload file</button>
      </div>

      {#if mode === 'paste'}
        <textarea
          class="textarea ingest-text"
          rows="10"
          placeholder={'https://example.com/a\nhttps://example.com/b\n\n- [title](https://…) also works'}
          aria-label="URLs or text to ingest"
          bind:value={text}
          data-testid="ingest-textarea"
        ></textarea>
        <p class="meta ingest-hint">
          one URL per line · markdown `- [t](url)` also works · ≤ {MAX_URLS} urls
          {#if detected.length > 0}
            · <strong data-testid="url-count">{detected.length} urls detected</strong>
          {/if}
        </p>
        {#if overLimit}
          <p class="notice notice-bad" role="alert" data-testid="over-limit">
            {detected.length} urls detected — the limit is {MAX_URLS}. Split the list.
          </p>
        {/if}
        <div class="field-row">
          <label class="field">
            <span class="field-label">note (optional)</span>
            <input class="input" type="text" bind:value={note} placeholder="why these links" />
          </label>
          <label class="field">
            <span class="field-label">tags (optional)</span>
            <input class="input" type="text" bind:value={tagsInput} placeholder="ai, eng" />
          </label>
        </div>
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
            <p class="meta">drop a file here or</p>
          {/if}
          <label class="btn btn-sm">
            choose file
            <input
              type="file"
              accept={ACCEPT}
              class="sr-only"
              onchange={onFileInput}
              data-testid="ingest-file-input"
            />
          </label>
          <p class="meta">.md .txt .html .json .csv</p>
        </div>
      {/if}

      {#if submitError}
        <p class="notice notice-bad" role="alert" data-testid="ingest-error">{submitError}</p>
      {/if}

      <footer class="ingest-foot">
        <button type="button" class="btn" onclick={close}>Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          disabled={submitting || overLimit || (mode === 'paste' ? text.trim() === '' : file == null)}
          onclick={() => void submit()}
          data-testid="ingest-submit"
        >
          {submitting ? 'Ingesting…' : mode === 'paste' && detected.length > 0 ? `Ingest ${detected.length} link${detected.length === 1 ? '' : 's'}` : 'Ingest'}
        </button>
      </footer>
    {:else}
      <!-- progress / result state -->
      <div class="job-view" data-testid="ingest-job">
        {#if status === 'busy'}
          <p class="notice notice-warn" role="status">
            another ingest is running{job.busy?.pid != null ? ` (pid ${job.busy.pid})` : ''}
            {#if job.busy?.runId != null}· run {job.busy.runId}{/if}
          </p>
          <footer class="ingest-foot">
            <button type="button" class="btn" onclick={close}>Close</button>
          </footer>
        {:else}
          <p class="job-line meta">
            job {job.jobId || '—'} · {status}
          </p>
          {#if status !== 'failed'}
            <div
              class="progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax={total || 1}
              aria-valuenow={done}
              aria-label="Ingest progress"
            >
              <div class="progress-fill" style={`width: ${pct}%`}></div>
            </div>
            <p class="meta">{done} / {total} · {pct}%</p>
          {/if}

          {#if status === 'failed'}
            <p class="notice notice-bad" role="alert" data-testid="ingest-failed">
              {effectiveJob?.error ?? 'ingest failed'}
            </p>
            <footer class="ingest-foot">
              <button type="button" class="btn" onclick={close}>Close</button>
              <button
                type="button"
                class="btn btn-primary"
                disabled={submitting}
                onclick={() => {
                  const j = job
                  job = null
                  liveJob = null
                  // retry re-posts nothing — inputs were consumed; simplest
                  // honest retry is closing and re-submitting from scratch.
                  void j
                }}
              >
                Retry
              </button>
            </footer>
          {:else if status === 'done'}
            <p class="job-summary" data-testid="ingest-summary">
              accepted {job.accepted} · duplicates {job.duplicates} · rejected {job.rejected}
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
              >view in pending</button>
              <button type="button" class="btn btn-primary" onclick={close}>Done</button>
            </footer>
          {:else}
            <p class="job-summary meta" data-testid="ingest-counters">
              accepted {job.accepted} · duplicates {job.duplicates} · rejected {job.rejected}
            </p>
            {#if visibleWarnings.length > 0}
              <div class="warnings">
                {#each visibleWarnings as w, i (i)}
                  <p class="meta warning-line">{w}</p>
                {/each}
                {#if !warningsAll && warnings.length > 5}
                  <button type="button" class="chip chip-button" onclick={() => (warningsAll = true)}>
                    +{warnings.length - 5} more
                  </button>
                {/if}
              </div>
            {/if}
            <footer class="ingest-foot">
              <span class="spacer"></span>
              <CopyButton text={job.jobId} label="copy job id" />
              <button type="button" class="btn" onclick={close}>Close</button>
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
  .warning-line {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
</style>
