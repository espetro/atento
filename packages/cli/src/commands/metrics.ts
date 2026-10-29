/**
 * metrics, eval and serve commands.
 */
import type { Command } from 'commander'
import { metricsSummary, type MetricsSummary } from '@linkinbox/core'
import type { CliContext } from '../context.js'
import { formatNumber, formatUsd, renderTable } from '../render.js'

/** metrics [--last 7d]: per-stage counts, durations, tokens and cost. */
export async function runMetrics(
  ctx: CliContext,
  range: string,
  json: boolean,
): Promise<MetricsSummary> {
  const summary = await metricsSummary(ctx.store, range)
  if (json) {
    console.log(JSON.stringify(summary, null, 2))
    return summary
  }
  if (summary.stages.length === 0) {
    console.log(`no metrics in the last ${range}`)
    return summary
  }
  const table = summary.stages.map((s) => [
    s.stage,
    s.runs,
    s.input,
    s.ok,
    s.errors,
    formatNumber(s.avgDurationMs),
    formatNumber(s.tokensIn),
    formatNumber(s.tokensOut),
    formatUsd(s.costUsd),
  ])
  console.log(renderTable(
    ['stage', 'runs', 'in', 'ok', 'err', 'avg ms', 'tok in', 'tok out', 'cost'],
    table,
  ))
  const tagged = summary.stages.filter((s) => Object.keys(s.errorsByTag).length > 0)
  for (const stage of tagged) {
    const detail = Object.entries(stage.errorsByTag)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`\n${stage.stage} errors by source: ${detail}`)
  }
  console.log(`\nrange: ${summary.since} .. ${summary.until}`)
  return summary
}

export interface EvalResult {
  available: boolean
  exitCode: number
  report?: unknown
}

/**
 * eval: run the golden-set evals. The runner lives in the repo's evals/
 * directory; when it is not present the command reports that evals are not
 * available instead of failing.
 */
export async function runEval(ctx: CliContext, runnerPath?: string): Promise<EvalResult> {
  const mod = await loadEvalModule(runnerPath)
  if (!mod) {
    console.log('evals not available: no evals/ runner found')
    return { available: false, exitCode: 0 }
  }
  const runEvalFn = mod.runEval
  if (typeof runEvalFn !== 'function') {
    console.log('evals not available: the runner exposes no runEval function')
    return { available: false, exitCode: 0 }
  }
  const report = (await runEvalFn({ store: ctx.store, config: ctx.config })) as
    | { passed?: boolean }
    | undefined
  const passed = report?.passed !== false
  console.log(JSON.stringify(report, null, 2))
  if (!passed) {
    process.exitCode = 1
  }
  return { available: true, exitCode: passed ? 0 : 1, report }
}

type EvalModule = { runEval?: (opts: unknown) => Promise<unknown> } | null

async function loadEvalModule(runnerPath?: string): Promise<EvalModule> {
  const candidates = runnerPath
    ? [runnerPath]
    : [
        new URL('../../../evals/runner.js', import.meta.url).pathname,
        new URL('../../../evals/runner.ts', import.meta.url).pathname,
      ]
  for (const candidate of candidates) {
    try {
      return (await import(candidate)) as EvalModule
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** serve: stub that hands over to @linkinbox/server when it is installed. */
export async function runServe(ctx: CliContext, port?: number): Promise<boolean> {
  let mod: { startServer?: (opts: unknown) => Promise<unknown> } | null = null
  try {
    // Indirected so @linkinbox/server stays optional at build time.
    const specifier = '@linkinbox/server'
    mod = (await import(specifier)) as { startServer?: (opts: unknown) => Promise<unknown> }
  } catch {
    mod = null
  }
  if (!mod || typeof mod.startServer !== 'function') {
    console.log('server not available: @linkinbox/server is not installed')
    return false
  }
  await mod.startServer({ port, store: ctx.store, config: ctx.config })
  return true
}

export function registerReportingCommands(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  program
    .command('metrics')
    .description('per-stage counts, durations, tokens and cost')
    .option('--last <range>', 'time range, e.g. 7d, 24h, 2w', '7d')
    .option('--json', 'print json')
    .action(async (opts: { last?: string; json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        await runMetrics(ctx, opts.last ?? '7d', opts.json === true)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('eval')
    .description('run the golden-set evals')
    .option('--runner <path>', 'path to the eval runner module')
    .action(async (opts: { runner?: string }) => {
      const ctx = await deps.ctx()
      try {
        await runEval(ctx, opts.runner)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('serve')
    .description('serve the web ui (requires @linkinbox/server)')
    .option('--port <port>', 'port to listen on', Number)
    .action(async (opts: { port?: number }) => {
      const ctx = await deps.ctx()
      try {
        await runServe(ctx, opts.port)
      } finally {
        await ctx.close()
      }
    })
}
