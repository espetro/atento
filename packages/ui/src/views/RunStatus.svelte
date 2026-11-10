<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api, ApiError } from '../lib/api'
  import { sseConnected, sseRunLog } from '../lib/events'
  import { timeAgo, fmtDuration, fmtTokens, fmtCost } from '../lib/format'
  import { collectionMeta } from '../lib/copy'
  import { runVerdict } from '../lib/runVerdict'
  import CopyButton from '../lib/components/CopyButton.svelte'
  import StateChip from '../lib/components/StateChip.svelte'
  import IconRefreshCw from '~icons/lucide/refresh-cw'
  import IconPause from '~icons/lucide/pause'
  import IconArrowRight from '~icons/lucide/arrow-right'
  import type { UrlState } from '../lib/urlState'
  import type { RunResult, RunJournalRow } from '../lib/types'
  import { m } from '../paraglide/messages.js'

  let { url, setUrl }: { url: UrlState; setUrl: (next: Partial<UrlState>) => void } = $props()

  const queryClient = useQueryClient()

  const runsQuery = createQuery(() => ({
    queryKey: ['runs', 30],
    queryFn: () => api.runs(30),
    refetchInterval: 15_000,
  }))
  const summaryQuery = createQuery(() => ({
    queryKey: ['collections-summary'],
    queryFn: () => api.collectionsSummary(),
    staleTime: 10_000,
  }))

  const journalRows = $derived($sseRunLog)
  // Merge SSE journal with fetched rows (fetched wins on id collision for
  // fresher server-side fields; SSE supplies rows not yet fetched).
  const runs = $derived.by(() => {
    const fetched = runsQuery.data?.runs ?? []
    const byId = new Map<number, RunJournalRow>()
    for (const r of journalRows) byId.set(r.id, r)
    for (const r of fetched) byId.set(r.id, r)
    return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 30)
  })

  const latestRun = $derived(runs[0] ?? null)

  // ---- run-now --------------------------------------------------------------
  let running = $state(false)
  let runResult = $state<RunResult | null>(null)
  let runError = $state('')
  let busyInfo = $state<{ runId?: number | string; pid?: number } | null>(null)
  let stageNow = $state('')

  const sseRun = $derived.by(() => {
    // Latest run event from the log for live stage display.
    return journalRows.length > 0 ? journalRows[journalRows.length - 1]! : null
  })
  const liveRunning = $derived(
    running || (sseRun != null && sseRun.status === 'running'),
  )

  async function runNow() {
    if (running) return
    running = true
    runError = ''
    busyInfo = null
    stageNow = ''
    try {
      const result = await api.run()
      runResult = result
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['runs'] }),
        queryClient.invalidateQueries({ queryKey: ['links'] }),
        queryClient.invalidateQueries({ queryKey: ['collections-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
      ])
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || /busy/i.test(err.message))) {
        busyInfo = (err.body as { busy?: { runId?: number | string; pid?: number } } | null)?.busy ?? {}
      } else {
        runError = err instanceof ApiError ? err.message : String(err)
      }
    } finally {
      running = false
    }
  }

  // ---- verdict --------------------------------------------------------------
  const verdict = $derived(
    runVerdict({ runResult, latestRun, runError, busyInfo, liveRunning }),
  )

  const attentionCounts = $derived(summaryQuery.data?.collections ?? {})
  const attentionTotal = $derived(
    ['needs_login', 'blocked', 'errored', 'review'].reduce(
      (n, k) => n + ((attentionCounts as Record<string, number>)[k] ?? 0),
      0,
    ),
  )
  const loginHosts = $derived(summaryQuery.data?.needsLoginHosts ?? [])

  function attentionLink(collection: string) {
    // Bridge banner: Attention shows "last run finished — N links need you"
    // when arriving from the run view.
    try {
      sessionStorage.setItem('atento:attention-from-run', '1')
    } catch {
      /* storage unavailable — banner simply won't show */
    }
    setUrl({ view: 'attention', collection, selected: null, q: '', state: '', category: '', host: '', stale: false })
  }

  function stageRows(result: RunResult) {
    const s = result.summary
    const ingestJobs = s.ingest?.jobs ?? []
    const totals = ingestJobs.reduce(
      (acc, j) => ({
        accepted: acc.accepted + (j.accepted ?? 0),
        duplicates: acc.duplicates + (j.duplicates ?? 0),
        rejected: acc.rejected + (j.rejected ?? 0),
      }),
      { accepted: 0, duplicates: 0, rejected: 0 },
    )
    return [
      {
        name: 'ingest',
        status: 'done',
        in_: ingestJobs.length === 1 ? m.run_ingest_jobs_one({ count: ingestJobs.length }) : m.run_ingest_jobs_other({ count: ingestJobs.length }),
        ok: m.run_ingest_counters({ accepted: totals.accepted, duplicates: totals.duplicates, rejected: totals.rejected }),
        err: '',
        defer: '',
        nb: '',
        dur: '—',
        tok: '—',
        cost: '—',
      },
      {
        name: 'extract',
        status: s.extract?.busy ? 'busy' : 'done',
        in_: `${s.extract?.input ?? '—'} → ${s.extract?.ok ?? '—'}`,
        ok: '',
        err: m.run_err_count({ count: s.extract?.errors ?? 0 }),
        defer: m.run_deferred_count({ count: s.extract?.deferred ?? 0 }),
        nb: m.run_needs_browser({ count: s.extract?.needsBrowser ?? 0 }),
        dur: '—',
        tok: '—',
        cost: '—',
      },
      {
        name: 'enrich',
        status: s.enrich?.busy ? 'busy' : 'done',
        in_: `${s.enrich?.input ?? '—'} → ${s.enrich?.ok ?? '—'}`,
        ok: '',
        err: m.run_err_count({ count: s.enrich?.errors ?? 0 }),
        defer: m.run_deferred_count({ count: s.enrich?.deferred ?? 0 }),
        nb: '',
        dur: '—',
        tok: '—',
        cost: '—',
      },
      {
        name: 'sweep',
        status: 'done',
        in_: '—',
        ok: m.run_swept({ count: s.swept ?? 0 }),
        err: '',
        defer: '',
        nb: '',
        dur: '—',
        tok: '—',
        cost: '—',
      },
    ]
  }

  const STAGES = ['ingest', 'extract', 'enrich', 'sweep'] as const
</script>

<div class="run-view" data-testid="run-view">
  <header class="run-head">
    <h1 class="run-title">{m.run_title()}</h1>
    <button
      type="button"
      class="btn btn-primary"
      disabled={running || liveRunning}
      onclick={() => void runNow()}
      data-testid="run-now"
    >
      {running ? m.run_running() : liveRunning ? m.run_running_stage({ stage: sseRun?.stage ?? '' }) : m.run_now()}
    </button>
  </header>

  {#if !$sseConnected}
    <p class="notice notice-warn" role="status">{m.run_reconnecting()}</p>
  {/if}

  {#if verdict}
    <div class="verdict verdict-{verdict.tone}" role="status" data-testid="run-verdict">
      <span class="verdict-text">{verdict.text} · <strong>{m.run_exit({ code: verdict.code })}</strong></span>
      {#if verdict.code === 2}
        <span class="verdict-counts meta">
          {#each ['needs_login', 'errored', 'blocked'] as c (c)}
            {#if ((attentionCounts as Record<string, number>)[c] ?? 0) > 0}
              {collectionMeta(c).label} {((attentionCounts as Record<string, number>)[c] ?? 0)} ·
            {/if}
          {/each}
        </span>
        <button type="button" class="btn btn-sm" onclick={() => attentionLink('needs_login')}>
          {m.run_review_needs()}
        </button>
      {/if}
    </div>
  {/if}

  {#if liveRunning && !runResult}
    <section class="pane pane-pad live-panel" data-testid="live-run">
      <p class="live-title"><IconRefreshCw /> {m.run_live_title()}{sseRun?.id ? ` — ${m.run_live_run({ id: sseRun.id })}` : ''}</p>
      <div class="stage-stepper">
        {#each STAGES as stage, i (stage)}
          {@const idx = STAGES.indexOf((sseRun?.stage ?? 'ingest') as (typeof STAGES)[number])}
          <span class="step" class:is-now={i === idx} class:is-done={i < idx}>{stage}</span>
          {#if i < STAGES.length - 1}<span class="step-arrow"><IconArrowRight /></span>{/if}
        {/each}
      </div>
      {#if sseRun?.heartbeatAt}
        <p class="meta">{m.run_last_heartbeat({ time: timeAgo(sseRun.heartbeatAt) })}</p>
      {/if}
    </section>
  {/if}

  {#if busyInfo}
    <section class="pane pane-pad busy-panel" data-testid="busy-panel">
      <p class="busy-title"><IconPause /> {m.busy_title()}</p>
      <p class="meta">
        {busyInfo.runId != null ? m.busy_subject_run({ id: busyInfo.runId }) : m.busy_subject_generic()} {m.busy_holds_lock()}
        {#if busyInfo.pid != null}· {m.busy_pid({ pid: busyInfo.pid })}{/if}
        {m.busy_note()}
      </p>
    </section>
  {/if}

  {#if runResult}
    <section class="pane pane-pad">
      <p class="run-line meta" data-testid="run-line">
        {m.run_line({ id: runResult.runId, before: runResult.cursorBefore, after: runResult.cursorAfter })}
      </p>
      <table class="stage-table">
        <thead>
          <tr>
            <th>{m.th_stage()}</th><th>{m.th_status()}</th><th>{m.th_in_out()}</th><th>{m.th_errors()}</th><th>{m.th_deferred()}</th><th>{m.th_need_browser()}</th><th>{m.th_tokens()}</th><th>{m.th_cost()}</th>
          </tr>
        </thead>
        <tbody>
          {#each stageRows(runResult) as row (row.name)}
            <tr data-testid="stage-row-{row.name}">
              <td class="mono">{row.name}</td>
              <td><span class="chip chip-state-enriched">{row.status}</span></td>
              <td class="mono">{row.in_}</td>
              <td class="mono">{row.err || '—'}</td>
              <td class="mono">{row.defer || '—'}</td>
              <td class="mono">{row.nb || '—'}</td>
              <td class="mono">{row.tok}</td>
              <td class="mono">{row.cost}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    {#if runResult.summary.needsAction || attentionTotal > 0}
      <section class="pane pane-pad needs-action" data-testid="needs-action">
        <h2 class="section-title">{m.needs_action()}</h2>
        {#each ['needs_login', 'blocked', 'errored', 'review'] as c (c)}
          {@const count = (attentionCounts as Record<string, number>)[c] ?? 0}
          {#if count > 0}
            <div class="na-row">
              <StateChip collection={c} />
              <span class="meta">{count === 1 ? m.count_links_one({ count }) : m.count_links_other({ count })}</span>
              {#if c === 'needs_login'}
                {#each loginHosts.slice(0, 3) as h (h.host)}
                  <code class="mono meta">atento login {h.host}</code>
                  <CopyButton text={`atento login ${h.host}`} label={m.action_copy()} />
                {/each}
              {/if}
              <button type="button" class="btn btn-sm btn-ghost" onclick={() => attentionLink(c)}>
                {m.run_open_collection({ label: collectionMeta(c).label })}
              </button>
            </div>
          {/if}
        {/each}
      </section>
    {/if}
  {/if}

  <section class="pane pane-pad journal" data-testid="run-journal">
    <h2 class="section-title">{m.journal_title()}</h2>
    {#if runs.length === 0}
      <p class="meta">{m.journal_empty()}</p>
    {:else}
      <table class="journal-table">
        <thead>
          <tr><th>#</th><th>{m.th_stage()}</th><th>{m.th_status()}</th><th>{m.th_started()}</th><th>{m.th_in_out_err()}</th><th>{m.th_duration()}</th><th>{m.th_tokens()}</th><th>{m.th_cost()}</th></tr>
        </thead>
        <tbody>
          {#each runs as row (row.id)}
            <tr>
              <td class="mono">{row.id}</td>
              <td class="mono">{row.stage}</td>
              <td>{row.status ?? '—'}</td>
              <td class="meta">{timeAgo(row.startedAt)}</td>
              <td class="mono">{row.inputCount}/{row.okCount}/{row.errorCount}</td>
              <td class="mono">{fmtDuration(row.durationMs)}</td>
              <td class="mono">{fmtTokens((row.tokensIn ?? 0) + (row.tokensOut ?? 0))}</td>
              <td class="mono">{fmtCost(row.costUsd)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    <footer class="journal-foot">
      <a class="meta" href="?view=metrics">{m.metrics_link()}</a>
    </footer>
  </section>
</div>

<style>
  .run-view {
    max-width: 960px;
    margin: 0 auto;
    padding: 20px 20px 48px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    overflow-y: auto;
  }
  .run-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .run-title {
    font-size: 22px;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 10px;
    border: 1px solid var(--color-line);
    flex-wrap: wrap;
  }
  .verdict-ok {
    border-color: var(--color-state-enriched, #2e7d32);
    background: rgba(46, 125, 50, 0.08);
  }
  .verdict-warn {
    border-color: #b8860b;
    background: rgba(184, 134, 11, 0.1);
  }
  .verdict-bad {
    border-color: var(--color-state-errored, #b3261e);
    background: rgba(179, 38, 30, 0.08);
  }
  .verdict-neutral {
    background: var(--color-surface-raised);
  }
  .verdict-text {
    font-size: 14px;
    font-weight: 600;
  }
  .verdict-counts {
    flex: 1;
  }
  .live-panel .live-title {
    font-weight: 700;
    font-size: 14.5px;
    margin-bottom: 10px;
  }
  .stage-stepper {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .step {
    padding: 4px 10px;
    border-radius: 20px;
    border: 1px solid var(--color-line);
    font-size: 12.5px;
    color: var(--color-ink-faint);
  }
  .step.is-now {
    border-color: var(--color-accent-blue);
    color: var(--color-ink);
    font-weight: 700;
  }
  .step.is-done {
    color: var(--color-ink-soft);
  }
  .step-arrow {
    color: var(--color-ink-faint);
  }
  .busy-title {
    font-weight: 700;
    font-size: 14.5px;
  }
  .section-title {
    font-size: 15px;
    margin-bottom: 10px;
  }
  .stage-table,
  .journal-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .stage-table th,
  .journal-table th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-ink-faint);
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .stage-table td,
  .journal-table td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .needs-action {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .na-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .journal {
    display: flex;
    flex-direction: column;
  }
  .journal-foot {
    margin-top: 10px;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .meta {
    color: var(--color-ink-soft);
    font-size: 12.5px;
  }
</style>
