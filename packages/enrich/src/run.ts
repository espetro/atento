import {
  EnrichmentSchema,
  STAGES,
  busyRunOf,
  reclaimCrashedRuns,
  startRunHeartbeat,
  type BusyRun,
  type Enrichment,
  type Store,
} from '@atento/core'
import { buildPrompt, type PromptLink } from './prompt.js'
import { ENRICHMENT_JSON_SCHEMA, chatComplete, chatConfigFromEnv, parseEnrichment, type ChatConfig } from './chat.js'

export type { EnrichmentInput } from '@atento/core'

/**
 * A model is anything that turns (system, prompt) into JSON text plus token usage.
 * The default implementation is a plain fetch call to an OpenAI-compatible endpoint.
 */
export interface EnrichModel {
  readonly modelId: string
  generate(req: {
    system: string
    prompt: string
  }): Promise<{ text: string; tokensIn: number; tokensOut: number }>
}

/** A model over an OpenAI-compatible chat completions endpoint (no SDK). */
export function createChatModel(cfg: ChatConfig): EnrichModel {
  return {
    modelId: cfg.model,
    async generate(req) {
      const reply = await chatComplete(cfg, req.system, req.prompt, 'enrichment', ENRICHMENT_JSON_SCHEMA)
      if (!reply.ok) throw new Error(reply.error)
      return { text: reply.text, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut }
    },
  }
}

/** Env-configured model access. No hardcoded provider or model. */
export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): EnrichModel {
  return createChatModel(chatConfigFromEnv(env))
}

export interface EnrichDeps {
  model: EnrichModel
  now?: () => Date
  /** Override token usage, e.g. when the provider does not report it. */
  usage?: { tokensIn: number; tokensOut: number }
}

export type EnrichResult =
  | { ok: true; enrichment: Enrichment; usage: { tokensIn: number; tokensOut: number }; modelId: string }
  | { ok: false; error: string; stage: 'model' | 'parse' | 'empty'; modelId: string | null }

/**
 * ONE structured-output call per link. Never throws on model or parse
 * failure; returns a typed error result instead.
 */
export async function enrichLink(link: PromptLink, deps: EnrichDeps): Promise<EnrichResult> {
  const { system, user } = buildPrompt({ link, now: deps.now?.() })
  const modelId = String(deps.model.modelId)
  let reply: { text: string; tokensIn: number; tokensOut: number }
  try {
    reply = await deps.model.generate({ system, prompt: user })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), stage: 'model', modelId }
  }
  const parsed = parseEnrichment(reply.text)
  if (!parsed.ok) return { ok: false, error: parsed.error, stage: 'parse', modelId }
  // The hand validator and the schema must agree; the schema stays the contract.
  const checked = EnrichmentSchema.safeParse(parsed.value)
  if (!checked.success) {
    return { ok: false, error: `No object generated: ${checked.error.message}`, stage: 'parse', modelId }
  }
  return {
    ok: true,
    enrichment: checked.data,
    usage: deps.usage ?? { tokensIn: reply.tokensIn, tokensOut: reply.tokensOut },
    modelId,
  }
}

export interface EnrichPendingResult {
  processed: number
  okCount: number
  errorCount: number
  tokensIn: number
  tokensOut: number
  /** Set when another enrich run holds the journal lock; nothing was processed. */
  busy?: BusyRun
}

/**
 * Enrich inbox links that have extracted content but no enrichment yet.
 * Writes via store.setEnrichment + store.setExpiry and records usage in
 * a `runs` row plus metrics.
 *
 * Holds the same journal lock as the pipeline enrich stage: crashed runs
 * are reclaimed first, `acquireRun` makes this the single writer for
 * 'enrich', and the heartbeat keeps a live run from being reclaimed as
 * crashed. Journal time is wall-clock; `deps.now` only dates the prompt.
 */
export async function enrichPending(
  store: Store,
  deps: EnrichDeps,
  opts: { limit?: number } = {},
): Promise<EnrichPendingResult> {
  const candidates = (await store.listLinks({ status: 'inbox' })).filter(
    (l) => l.extractedContent !== null && !l.needsBrowser && l.enrichment === null,
  )
  const batch = opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates

  await reclaimCrashedRuns(store)
  const acquired = await store.acquireRun(STAGES.enrich, { pid: process.pid })
  if (!acquired.ok) {
    return {
      processed: 0,
      okCount: 0,
      errorCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      busy: busyRunOf(acquired.busy),
    }
  }
  const journal = acquired.run
  const stopHeartbeat = startRunHeartbeat(store, journal.id)
  const startedAt = Date.now()

  try {
    let okCount = 0
    let errorCount = 0
    let tokensIn = 0
    let tokensOut = 0

    for (const link of batch) {
      const result = await enrichLink(link, deps)
      if (result.ok) {
        okCount += 1
        tokensIn += result.usage.tokensIn
        tokensOut += result.usage.tokensOut
        await store.setEnrichment(link.id, result.enrichment)
      } else {
        errorCount += 1
        await store.addMetric({
          timestamp: new Date(),
          stage: 'enrich',
          key: 'error',
          value: 1,
          tags: { link_id: String(link.id), stage: result.stage },
        })
      }
    }

    await store.finishRun(journal.id, {
      finishedAt: new Date(),
      okCount,
      errorCount,
      durationMs: Date.now() - startedAt,
      tokensIn,
      tokensOut,
      inputCount: batch.length,
    })
    await store.addMetric({
      timestamp: new Date(),
      stage: 'enrich',
      key: 'processed',
      value: batch.length,
      tags: null,
    })

    return { processed: batch.length, okCount, errorCount, tokensIn, tokensOut }
  } catch (err) {
    await store
      .finishRun(journal.id, { finishedAt: new Date(), status: 'failed', errorCount: 1 })
      .catch(() => {})
    throw err
  } finally {
    stopHeartbeat()
  }
}
