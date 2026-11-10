/**
 * Pipeline-stage tools: extract_run, enrich_run, plus the read-only
 * metrics, limits and login-pending reports.
 */
import { z } from 'zod/mini'
import {
  DEFAULT_LIMITS,
  LLM_KEY,
} from '@atento/app'
import { json, type ToolDef } from './types.js'

const optionalLimit = z.optional(z.number().check(z.int(), z.positive()))

export const pipelineTools: ToolDef[] = [
  {
    name: 'extract_run',
    description: 'Run extraction on inbox links lacking content (spec name extract.run).',
    inputSchema: z.object({ limit: optionalLimit }),
    handler: async (env, args: { limit?: number }) => {
      const { ctx, ops } = env
      // Same guard shape as before: limits + [login], no pacing.
      const guard = ops.guardDeps({
        ...(ctx.limits ? { limits: ctx.limits } : {}),
        ...(ctx.login ? { login: ctx.login } : {}),
      })
      const outcome = await ops.extract({
        extract: await env.deps.extractFn(ctx),
        limit: args.limit,
        guard,
        maxBatch: ctx.limits?.maxBatch ?? DEFAULT_LIMITS.maxBatch,
        logger: ctx.logger,
      })
      return json({
        okCount: outcome.okCount,
        errorCount: outcome.errorCount,
        needsBrowserCount: outcome.needsBrowserCount,
        reviewOnlyCount: outcome.reviewOnlyCount,
        deferredCount: outcome.deferredCount,
        retryAfter: outcome.retryAfter,
      })
    },
  },

  {
    name: 'enrich_run',
    description:
      'Run enrichment (spec name enrich.run). Model identity comes from env config; nothing here names a provider.',
    inputSchema: z.object({ limit: optionalLimit }),
    handler: async (env, args: { limit?: number }) => {
      const { ctx, ops } = env
      const outcome = await ops.enrich({
        enrich: await env.deps.enrichFn(),
        limit: args.limit,
        guard: ops.guardDeps(),
        maxBatch: DEFAULT_LIMITS.maxBatch,
        ttl: ctx.ttl,
        logger: ctx.logger,
      })
      return json({
        linkIds: outcome.linkIds,
        okCount: outcome.okCount,
        errorCount: outcome.errorCount,
        deferredCount: outcome.deferredCount,
        retryAfter: outcome.retryAfter,
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costUsd: outcome.costUsd,
      })
    },
  },

  {
    name: 'metrics_get',
    description: 'Per-stage metrics summary (spec name metrics.get), range like 24h, 7d, 2w.',
    inputSchema: z.object({ range: z.optional(z.string()), now: z.optional(z.iso.datetime()) }),
    handler: async (env, args: { range?: string; now?: string }) => {
      const summary = await env.ops.metrics(
        args.range ?? '7d',
        args.now !== undefined ? new Date(args.now) : new Date(),
      )
      return json(summary)
    },
  },

  {
    name: 'limits_status',
    description:
      'Rate limit budget and circuit breaker state per host (spec name limits.status). ' +
      'Read-only: it never mutates state. Breaker reset stays CLI-only.',
    inputSchema: z.object({}),
    handler: async (env) => {
      const { ctx, ops } = env
      // Report the hosts that have state; there is no hardcoded default
      // list, so an untouched install reports only the llm key.
      const states = await ctx.store.listHostStates()
      const keys = new Set<string>(states.map((s) => s.key))
      keys.add(LLM_KEY)
      const rows = await ops.guardStatusesFor([...keys].sort())
      return json({
        hosts: rows.map((row) => ({
          key: row.key,
          breakerState: row.breakerState,
          reopensAt: row.reopensAt,
          dailyCap: row.dailyCap === Number.POSITIVE_INFINITY ? 'unlimited' : row.dailyCap,
          remainingToday:
            row.remainingToday === Number.POSITIVE_INFINITY
              ? 'unlimited'
              : row.remainingToday,
          lastRequestAt: row.lastRequestAt,
          consecutiveFailures: row.consecutiveFailures,
          lastError: row.lastError,
          trialState: row.trialState,
          trialReason: row.trialReason,
          rateLimitedUntil: row.rateLimitedUntil,
          policy: row.policy,
        })),
      })
    },
  },

  {
    name: 'login_pending',
    description:
      'Hosts that still need a browser login (spec name login.pending). ' +
      'Read-only: pending hosts with their waiting link counts, and the ' +
      'hosts that already have a saved profile with its age. The browser ' +
      'login itself is a CLI step (atento login): it needs a terminal.',
    inputSchema: z.object({}),
    handler: async (env) => {
      const { ctx, ops } = env
      return json(
        await ops.loginPending({
          limits: ctx.limits,
          loginAllow: ctx.login?.allow,
        }),
      )
    },
  },
]
