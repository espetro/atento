/**
 * metrics, eval and serve commands.
 */
import type { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MetricsSummary } from '@linkinbox/app'
import type { CliContext } from '../context.js'
import { formatNumber, formatUsd, renderTable } from '../render.js'

/** metrics [--last 7d]: per-stage counts, durations, tokens and cost. */
export async function runMetrics(
  ctx: CliContext,
  range: string,
  json: boolean,
): Promise<MetricsSummary> {
  const summary = await ctx.app.metrics(range)
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
  const counts = summary.stages.filter((s) => Object.keys(s.countsByTag).length > 0)
  for (const stage of counts) {
    const detail = Object.entries(stage.countsByTag)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`\n${stage.stage} breakdown: ${detail}`)
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
  if (runnerPath === undefined) {
    const bin = evalBinCandidates().find((candidate) => existsSync(candidate))
    if (bin !== undefined) {
      // The repo's eval bin loads the fixtures, prints the report and exits
      // non-zero on a regression. Its output and exit code pass straight through.
      const res = spawnSync(process.execPath, [bin], { stdio: 'inherit', env: process.env })
      const exitCode = res.status ?? 1
      if (exitCode !== 0) process.exitCode = exitCode
      return { available: true, exitCode }
    }
  }
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

/** Built eval bin: <repo>/evals/dist/bin.js, four levels up from src/ and dist/ commands. */
function evalBinCandidates(): string[] {
  return [fileURLToPath(new URL('../../../../evals/dist/bin.js', import.meta.url))]
}

type EvalModule = { runEval?: (opts: unknown) => Promise<unknown> } | null

/**
 * Candidate runner locations: an explicit path first, then the repo's evals/
 * directory (js, mjs and ts variants).
 */
export function evalRunnerCandidates(runnerPath?: string): string[] {
  if (runnerPath) return [runnerPath]
  const roots = [
    new URL('../../../../evals/', import.meta.url),
    new URL('../../../evals/', import.meta.url),
  ]
  const names = ['runner.js', 'runner.mjs', 'runner.ts']
  const out: string[] = []
  for (const root of roots) {
    for (const name of names) {
      out.push(fileURLToPath(new URL(name, root)))
    }
  }
  return out
}

async function loadEvalModule(runnerPath?: string): Promise<EvalModule> {
  for (const candidate of evalRunnerCandidates(runnerPath)) {
    try {
      return (await import(pathToFileURL(candidate).href)) as EvalModule
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** serve: hands over to @linkinbox/server, which serves api and ui on one port. */
export async function runServe(
  ctx: CliContext,
  port?: number,
  /** Test hook: receives the started server handle. */
  onStart?: (server: { port: number; close(): Promise<void> }) => void,
): Promise<boolean> {
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
  const envPort = Number(process.env['LINKINBOX_PORT'] ?? '')
  const effective = port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 4173)
  console.log(`serving on http://localhost:${effective}`)
  const started = (await mod.startServer({
    port: effective,
    store: ctx.store,
    config: ctx.config,
    hostname: '127.0.0.1',
    capture: ctx.config.capture,
  })) as { port: number; close(): Promise<void> }
  onStart?.(started)
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
      let server: { close(): Promise<void> } | undefined
      try {
        await runServe(ctx, opts.port, (started) => {
          server = started
        })
        if (server !== undefined) {
          // The store has to outlive the action: keep it open until a signal.
          await new Promise<void>((resolve) => {
            process.once('SIGINT', resolve)
            process.once('SIGTERM', resolve)
          })
          await server.close()
        }
      } finally {
        await ctx.close()
      }
    })
}
