import { generateObject } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { EnrichmentSchema, type Enrichment, type Store } from '@linkinbox/core'
import { buildPrompt } from './prompt.js'

export type { EnrichmentInput } from '@linkinbox/core'

export type EnrichModel = LanguageModelV3

/** Env-configured model access. No hardcoded provider or model. */
export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): EnrichModel {
  const baseURL = env.OPENAI_COMPAT_BASE_URL
  const apiKey = env.OPENAI_COMPAT_API_KEY
  const modelId = env.LINKINBOX_MODEL
  if (!baseURL || !modelId) {
    throw new Error(
      'createModelFromEnv requires OPENAI_COMPAT_BASE_URL and LINKINBOX_MODEL to be set',
    )
  }
  const provider = createOpenAICompatible({
    name: 'linkinbox',
    baseURL,
    apiKey,
  })
  return provider(modelId)
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
export async function enrichLink(link: Parameters<typeof buildPrompt>[0]['link'], deps: EnrichDeps): Promise<EnrichResult> {
  const { system, user } = buildPrompt({ link, now: deps.now?.() })
  try {
    const result = await generateObject({
      model: deps.model,
      schema: EnrichmentSchema,
      system,
      prompt: user,
    })
    const enrichment = EnrichmentSchema.parse(result.object)
    const usage = deps.usage ?? {
      tokensIn: result.usage.inputTokens ?? 0,
      tokensOut: result.usage.outputTokens ?? 0,
    }
    return {
      ok: true,
      enrichment,
      usage,
      modelId: String(deps.model.modelId),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stage = message.includes('No object generated') ? 'parse' : 'model'
    return { ok: false, error: message, stage, modelId: String(deps.model.modelId) }
  }
}

export interface EnrichPendingResult {
  processed: number
  okCount: number
  errorCount: number
  tokensIn: number
  tokensOut: number
}

/**
 * Enrich inbox links that have extracted content but no enrichment yet.
 * Writes via store.setEnrichment + store.setExpiry and records usage in
 * a `runs` row plus metrics.
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

  const run = await store.startRun('enrich', batch.length)
  const startedAt = Date.now()
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

  await store.finishRun(run.id, {
    finishedAt: new Date(),
    okCount,
    errorCount,
    durationMs: Date.now() - startedAt,
    tokensIn,
    tokensOut,
  })
  await store.addMetric({
    timestamp: new Date(),
    stage: 'enrich',
    key: 'processed',
    value: batch.length,
    tags: null,
  })

  return { processed: batch.length, okCount, errorCount, tokensIn, tokensOut }
}
