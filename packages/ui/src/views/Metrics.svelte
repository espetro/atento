<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { api } from '../lib/api'
  import { m } from '../paraglide/messages.js'

  const query = createQuery(() => ({
    queryKey: ['metrics'],
    queryFn: () => api.metrics(),
  }))

  const stages = $derived(query.data?.stages ?? [])
  const daily = $derived(query.data?.daily ?? [])

  // Simple inline SVG sparkline over daily tokens. Semantic colors only.
  const sparkPoints = $derived.by(() => {
    if (daily.length < 2) return ''
    const max = Math.max(...daily.map((d) => d.tokens), 1)
    const w = 120
    const h = 32
    return daily
      .map((d, i) => {
        const x = (i / (daily.length - 1)) * w
        const y = h - (d.tokens / max) * h
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  })

  const fmt = (n: number) => n.toLocaleString('en-US')
</script>

<div class="metrics-view mx-auto w-full max-w-4xl p-3 md:p-6 space-y-4">
  <header class="flex items-center justify-between gap-2 flex-wrap">
    <h1 class="text-xl font-semibold">{m.metrics_title()}</h1>
    {#if sparkPoints}
      <svg viewBox="0 0 120 32" class="w-32 h-8" data-testid="sparkline" aria-label={m.metrics_sparkline_aria()}>
        <polyline
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="text-primary"
          points={sparkPoints}
        />
      </svg>
    {/if}
  </header>

  {#if query.isPending}
    <div class="skeleton h-48 w-full"></div>
  {:else if query.isError}
    <div class="alert alert-error">{m.metrics_load_error()}</div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm table-zebra" data-testid="metrics-table">
        <thead>
          <tr>
            <th>{m.th_stage_cap()}</th>
            <th>{m.th_runs()}</th>
            <th>OK</th>
            <th>{m.th_errors_cap()}</th>
            <th>p50 ms</th>
            <th>p95 ms</th>
            <th>{m.th_tokens_in()}</th>
            <th>{m.th_tokens_out()}</th>
            <th>{m.th_cost_usd()}</th>
          </tr>
        </thead>
        <tbody>
          {#each stages as s (s.stage)}
            <tr data-testid="metrics-row">
              <td class="font-medium">{s.stage}</td>
              <td>{s.runs}</td>
              <td>{s.ok}</td>
              <td>{s.errors}</td>
              <td>{fmt(s.p50_ms)}</td>
              <td>{fmt(s.p95_ms)}</td>
              <td>{fmt(s.tokens_in)}</td>
              <td>{fmt(s.tokens_out)}</td>
              <td>{s.cost_usd.toFixed(2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <section>
      <h2 class="font-medium mb-2">{m.metrics_daily()}</h2>
      <ul class="text-sm space-y-1" data-testid="daily-list">
        {#each daily as d (d.date)}
          <li class="flex justify-between gap-4">
            <span>{d.date}</span>
            <span class="text-base-content/60">{m.metrics_daily_line({ tokens: fmt(d.tokens), cost: d.cost_usd.toFixed(2) })}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .metrics-view {
    height: 100%;
    overflow-y: auto;
  }
</style>
