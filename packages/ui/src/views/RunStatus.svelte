<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query'
  import { api, ApiError } from '../lib/api'
  import { sseConnected, sseRunLog } from '../lib/events'
  import { timeAgo, fmtDuration, fmtTokens, fmtCost } from '../lib/format'
  import { collectionMeta } from '../lib/copy'
  import { runVerdict } from '../lib/runVerdict'
  import CopyButton from '../components/CopyButton.svelte'
  import StateChip from '../components/StateChip.svelte'
  import type { UrlState } from '../lib/urlState'
  import type { RunResult, RunJournalRow } from '../lib/types'

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
      sessionStorage.setItem('linkinbox:attention-from-run', '1')
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
        in_: `${ingestJobs.length} job${ingestJobs.length === 1 ? '' : 's'}`,
        ok: `${totals.accepted} accepted · ${totals.duplicates} dup · ${totals.rejected} rej`,
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
        err: `${s.extract?.errors ?? 0} err`,
        defer: `${s.extract?.deferred ?? 0} deferred`,
        nb: `${s.extract?.needsBrowser ?? 0} need browser`,
        dur: '—',
        tok: '—',
        cost: '—',
      },
      {
        name: 'enrich',
        status: s.enrich?.busy ? 'busy' : 'done',
        in_: `${s.enrich?.input ?? '—'} → ${s.enrich?.ok ?? '—'}`,
        ok: '',
        err: `${s.enrich?.errors ?? 0} err`,
        defer: `${s.enrich?.deferred ?? 0} deferred`,
        nb: '',
        dur: '—',
        tok: '—',
        cost: '—',
      },
      {
        name: 'sweep',
        status: 'done',
        in_: '—',
        ok: `${s.swept ?? 0} swept`,
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
    <h1 class="run-title">Pipeline run</h1>
    <button
      type="button"
      class="btn btn-primary"
      disabled={running || liveRunning}
      onclick={() => void runNow()}
      data-testid="run-now"
    >
      {running ? 'Running…' : liveRunning ? `Running · ${sseRun?.stage ?? ''}` : 'Run now'}
    </button>
  </header>

  {#if !$sseConnected}
    <p class="notice notice-warn" role="status">reconnecting to live updates…</p>
  {/if}

  {#if verdict}
    <div class="verdict verdict-{verdict.tone}" role="status" data-testid="run-verdict">
      <span class="verdict-text">{verdict.text} · <strong>exit {verdict.code}</strong></span>
      {#if verdict.code === 2}
        <span class="verdict-counts meta">
          {#each ['needs_login', 'errored', 'blocked'] as c (c)}
            {#if ((attentionCounts as Record<string, number>)[c] ?? 0) > 0}
              {collectionMeta(c).label} {((attentionCounts as Record<string, number>)[c] ?? 0)} ·
            {/if}
          {/each}
        </span>
        <button type="button" class="btn btn-sm" onclick={() => attentionLink('needs_login')}>
          review what needs you →
        </button>
      {/if}
    </div>
  {/if}

  {#if liveRunning && !runResult}
    <section class="pane live-panel" data-testid="live-run">
      <p class="live-title">⟳ Run in progress{sseRun?.id ? ` — run #${sseRun.id}` : ''}</p>
      <div class="stage-stepper">
        {#each STAGES as stage, i (stage)}
          {@const idx = STAGES.indexOf((sseRun?.stage ?? 'ingest') as (typeof STAGES)[number])}
          <span class="step" class:is-now={i === idx} class:is-done={i < idx}>{stage}</span>
          {#if i < STAGES.length - 1}<span class="step-arrow">→</span>{/if}
        {/each}
      </div>
      {#if sseRun?.heartbeatAt}
        <p class="meta">last heartbeat {timeAgo(sseRun.heartbeatAt)}</p>
      {/if}
    </section>
  {/if}

  {#if busyInfo}
    <section class="pane busy-panel" data-testid="busy-panel">
      <p class="busy-title">⏸ Another run is in progress</p>
      <p class="meta">
        {busyInfo.runId != null ? `run ${busyInfo.runId}` : 'a run'} holds the lock
        {#if busyInfo.pid != null}· pid {busyInfo.pid}{/if}
        — this view updates when it finishes.
      </p>
    </section>
  {/if}

  {#if runResult}
    <section class="pane">
      <p class="run-line meta" data-testid="run-line">
        run {runResult.runId} · cursor {runResult.cursorBefore} → {runResult.cursorAfter}
      </p>
      <table class="stage-table">
        <thead>
          <tr>
            <th>stage</th><th>status</th><th>in → ok</th><th>errors</th><th>deferred</th><th>need browser</th><th>tokens</th><th>cost</th>
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
      <section class="pane needs-action" data-testid="needs-action">
        <h2 class="section-title">Needs action</h2>
        {#each ['needs_login', 'blocked', 'errored', 'review'] as c (c)}
          {@const count = (attentionCounts as Record<string, number>)[c] ?? 0}
          {#if count > 0}
            <div class="na-row">
              <StateChip collection={c} />
              <span class="meta">{count} link{count === 1 ? '' : 's'}</span>
              {#if c === 'needs_login'}
                {#each loginHosts.slice(0, 3) as h (h.host)}
                  <code class="mono meta">linkinbox login {h.host}</code>
                  <CopyButton text={`linkinbox login ${h.host}`} label="copy" />
                {/each}
              {/if}
              <button type="button" class="btn btn-sm btn-ghost" onclick={() => attentionLink(c)}>
                open {collectionMeta(c).label} →
              </button>
            </div>
          {/if}
        {/each}
      </section>
    {/if}
  {/if}

  <section class="pane journal" data-testid="run-journal">
    <h2 class="section-title">Journal</h2>
    {#if runs.length === 0}
      <p class="meta">No runs yet — run one above or `linkinbox run` in a terminal.</p>
    {:else}
      <table class="journal-table">
        <thead>
          <tr><th>#</th><th>stage</th><th>status</th><th>started</th><th>in/ok/err</th><th>duration</th><th>tokens</th><th>cost</th></tr>
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
      <a class="meta" href="?view=metrics">metrics →</a>
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
    border-color: var(--color-accent);
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
