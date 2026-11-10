/**
 * Adapter between the (separately built) @atento/enrich package and the
 * core `EnrichFn` interface.
 *
 * The enrich package is loaded dynamically so the CLI works without it (the
 * pipeline then reports a clear error per link instead of failing to start).
 * Nothing here names a provider or a model: the enrich package reads its
 * model configuration from the environment.
 */
import type { EnrichFn, Enrichment, Link } from '@atento/core'

export interface EnrichAdapterOptions {
  /** Override the module loader (tests). */
  load?: () => Promise<unknown>
  /** Environment holding the model config. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
}

interface EnrichModule {
  createEnrichFn?: (options?: unknown) => EnrichFn
  runEnrich?: (link: Link, options?: unknown) => Promise<unknown>
  enrichLink?: (link: Link, options?: unknown) => Promise<unknown>
  createModelFromEnv?: (env?: NodeJS.ProcessEnv) => unknown
}

/** Shape returned by the enrich package before adaptation. */
type RawEnrichResult =
  | {
      ok: true
      enrichment: Enrichment
      tokensIn?: number
      tokensOut?: number
      usage?: { tokensIn: number; tokensOut: number }
      costUsd?: number
      modelId?: string
      model?: string
    }
  | { ok: false; error: string; message?: string }

/** Default loader: dynamic import of @atento/enrich. */
async function defaultLoad(): Promise<unknown> {
  // The specifier is indirected so the optional package is not a hard
  // dependency: TypeScript does not try to resolve it at build time and the
  // runtime import fails cleanly when the package is absent.
  const specifier = '@atento/enrich'
  return import(specifier)
}

/**
 * Build an EnrichFn from the enrich package. When the package is missing the
 * returned function fails every call with a clear message, so the pipeline
 * records an explicit per-link error instead of crashing.
 */
export async function createEnrichFn(options: EnrichAdapterOptions = {}): Promise<EnrichFn> {
  const load = options.load ?? defaultLoad
  let mod: EnrichModule
  try {
    mod = (await load()) as EnrichModule
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return async () => ({
      ok: false,
      error: `enrichment unavailable: @atento/enrich could not be loaded (${reason})`,
    })
  }

  if (typeof mod.createEnrichFn === 'function') {
    return mod.createEnrichFn()
  }

  const run = mod.runEnrich ?? mod.enrichLink
  if (typeof run === 'function') {
    // The model comes from OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY /
    // ATENTO_MODEL; a missing variable becomes a per-link error, not a crash.
    let deps: unknown
    let setupError: string | undefined
    if (typeof mod.createModelFromEnv === 'function') {
      try {
        deps = { model: mod.createModelFromEnv(options.env ?? process.env) }
      } catch (err) {
        setupError = err instanceof Error ? err.message : String(err)
      }
    }
    return async (link: Link) => {
      if (setupError !== undefined) {
        return { ok: false, error: `enrichment unavailable: ${setupError}` }
      }
      const raw = (await run(link, deps)) as RawEnrichResult
      return adaptResult(raw)
    }
  }

  return async () => ({
    ok: false,
    error: 'enrichment unavailable: @atento/enrich exposes no known entry point',
  })
}

/** Normalize the enrich package result into the core `EnrichFn` shape. */
export function adaptResult(raw: RawEnrichResult): Awaited<ReturnType<EnrichFn>> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'enrichment failed: empty result' }
  }
  if (raw.ok === false) {
    return { ok: false, error: raw.error ?? raw.message ?? 'enrichment failed' }
  }
  return {
    ok: true,
    enrichment: raw.enrichment,
    tokensIn: raw.tokensIn ?? raw.usage?.tokensIn ?? 0,
    tokensOut: raw.tokensOut ?? raw.usage?.tokensOut ?? 0,
    ...(raw.costUsd !== undefined ? { costUsd: raw.costUsd } : {}),
    modelId: raw.modelId ?? raw.model ?? 'unknown',
  }
}
