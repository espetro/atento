/**
 * Resilience status commands: `status` (per-host budget, breaker state,
 * reopen time) and `breaker reset <host>`.
 */
import type { Command } from 'commander'
import { LLM_KEY } from '@linkinbox/app'
import type { CliContext } from '../context.js'

/** Hosts to report: every tracked host_state key plus the llm key. */
export async function statusKeys(ctx: CliContext): Promise<string[]> {
  const states = await ctx.store.listHostStates()
  const keys = new Set<string>(states.map((s) => s.key))
  keys.add(LLM_KEY)
  return [...keys].sort()
}

/** Render one status line per host. */
export function renderStatus(
  rows: Array<{
    key: string
    breakerState: string
    reopensAt: string | null
    dailyCap: number | 'unlimited'
    remainingToday: number
    consecutiveFailures: number
    lastError: string | null
    trialState?: string
    trialReason?: string | null
    rateLimitedUntil?: string | null
  }>,
): string[] {
  return rows.map((row) => {
    const cap = row.dailyCap === 'unlimited'
      ? 'unlimited'
      : `${row.remainingToday}/${row.dailyCap} left`
    const reopen = row.reopensAt !== null ? ` reopens ${row.reopensAt}` : ''
    const err = row.lastError !== null ? ` last=${row.lastError}` : ''
    const trial = row.trialState !== undefined && row.trialState !== 'unknown'
      ? ` trial=${row.trialState}${row.trialReason ? `:${row.trialReason}` : ''}`
      : ''
    return `${row.key}: breaker=${row.breakerState} budget=${cap}${reopen}${err}${trial}`
  })
}

export function registerResilienceCommands(
  program: Command,
  deps: { ctx: () => Promise<CliContext> },
): void {
  program
    .command('status')
    .description('per-host rate limit budget, circuit breaker state and reopen time')
    .option('--json', 'emit JSON')
    .action(async (opts: { json?: boolean }) => {
      const ctx = await deps.ctx()
      try {
        const rows = await ctx.app.guardStatusesFor(await statusKeys(ctx))
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2))
          return
        }
        for (const line of renderStatus(rows)) console.log(line)
      } finally {
        await ctx.close()
      }
    })

  const breaker = program.command('breaker').description('circuit breaker controls')
  breaker
    .command('reset <host>')
    .description('force-close the breaker for a host (or "llm")')
    .action(async (host: string) => {
      const ctx = await deps.ctx()
      try {
        const key = host === 'llm' ? LLM_KEY : host.toLowerCase()
        const state = await ctx.app.guardResetFor(key)
        console.log(`breaker for ${state.key}: closed (cooldown level reset)`)
      } finally {
        await ctx.close()
      }
    })
}
