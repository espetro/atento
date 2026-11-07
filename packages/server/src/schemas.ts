/**
 * OpenAPI-facing zod/mini schemas for the HTTP API. These describe the wire
 * contract served at /openapi.json; handlers keep their own (compatible)
 * runtime validation. Response schemas are intentionally permissive where
 * the payload is a projection (looseObject) — the contract documents the
 * stable keys, not every additive field.
 */
import { z } from 'zod/mini'
import { resolver, type ResolverReturnType } from 'hono-openapi'
import { COLLECTION_NAMES } from '@linkinbox/app'
import { LINK_STATES } from '@linkinbox/core'

export const ErrorBody = z.object({
  error: z.string(),
})

/** Permissive object for ad-hoc json payloads in the spec. */
export const JsonObject = z.record(z.string(), z.unknown())

interface JsonResponse {
  description: string
  content: Record<string, { schema: ResolverReturnType }>
}

/** The 500/400 fallback every route can produce. */
export const errorResponses: Record<string, JsonResponse> = {
  400: {
    description: 'Bad request',
    content: { 'application/json': { schema: resolverOf(ErrorBody) } },
  },
  401: {
    description: 'Missing or wrong bearer token (non-loopback binds)',
    content: { 'application/json': { schema: resolverOf(ErrorBody) } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: resolverOf(ErrorBody) } },
  },
  500: {
    description: 'Internal error',
    content: { 'application/json': { schema: resolverOf(ErrorBody) } },
  },
} as const

/** Wrap a zod/mini schema for hono-openapi's `resolver()` slots. */
export function resolverOf<S extends z.ZodMiniType>(schema: S): ResolverReturnType {
  return resolver(schema as never)
}

// ---- ingest ------------------------------------------------------------

export const IngestJobSummaryBody = z.looseObject({
  jobId: z.string(),
  accepted: z.number(),
  duplicates: z.number(),
  rejected: z.number(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'busy']),
  warnings: z.array(z.string()),
})

export const IngestStatusBody = z.looseObject({
  jobId: z.string(),
  source: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  total: z.number(),
  done: z.number(),
  cursor: z.number(),
  runId: z.nullable(z.number()),
  error: z.nullable(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.nullable(z.string()),
})

export const IngestJobResponse = z.object({ job: IngestStatusBody })

export const IngestInputBody = z.union([
  z.object({
    kind: z.literal('urls'),
    urls: z.array(z.string()).check(z.minLength(1), z.maxLength(500)),
    note: z.optional(z.string()),
    tags: z.optional(z.array(z.string())),
  }),
  z.object({ kind: z.literal('remote'), url: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
])

// ---- pairing -------------------------------------------------------------

/** GET /api/pair/code: a short-lived one-time code for POST /api/pair. */
export const PairCodeBody = z.object({
  code: z.string(),
  expiresAt: z.string(),
})

export const PairExchangeBody = z.object({
  code: z.string(),
})

/** POST /api/pair: the bearer tokens the client should store. */
export const PairTokensBody = z.object({
  captureToken: z.nullable(z.string()),
  serverToken: z.nullable(z.string()),
})

// ---- links ---------------------------------------------------------------

/** The UI-shaped link row: stable documented keys, additive fields allowed. */
export const LinkRow = z.looseObject({
  id: z.number(),
  url: z.string(),
  title: z.nullable(z.string()),
  status: z.string(),
  state: z.optional(z.string()),
  reason: z.optional(z.nullable(z.string())),
  host: z.optional(z.string()),
  added_at: z.optional(z.string()),
  updated_at: z.optional(z.string()),
})

export const LinkListResponse = z.object({
  items: z.array(LinkRow),
  total: z.number(),
})

export const LinkResponse = LinkRow

export const LinkPatchBody = z.object({
  title: z.optional(z.nullable(z.string())),
  note: z.optional(z.nullable(z.string())),
  tags: z.optional(z.array(z.string())),
})

export const ReextractBody = z.object({
  adapter: z.optional(z.string()),
  limit: z.optional(z.number().check(z.int(), z.positive())),
})

export const ReextractResponse = z.looseObject({
  ok: z.boolean(),
})

// ---- collections ---------------------------------------------------------

export const CollectionsSummaryBody = z.looseObject({
  total: z.optional(z.number()),
})

export const CollectionReadResponse = z.looseObject({
  rows: z.array(z.record(z.string(), z.unknown())),
  cursor: z.number(),
})

export const CollectionExportBody = z.object({
  name: z.enum(COLLECTION_NAMES as unknown as [string, ...string[]]),
  since: z.optional(z.number()),
  fields: z.optional(z.array(z.string())),
  format: z.optional(z.enum(['jsonl', 'md', 'tsv'])),
})

export const CollectionNameParam = z.enum(
  COLLECTION_NAMES as unknown as [string, ...string[]],
)

// ---- pipeline ------------------------------------------------------------

export const PipelineOverviewResponse = z.object({
  byState: z.record(z.string(), z.number()),
  byParkReason: z.record(z.string(), z.number()),
  byHost: z.array(
    z.looseObject({
      host: z.string(),
      total: z.number(),
    }),
  ),
})

export const TriageBody = z.object({
  ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
  action: z.enum(['read_now', 'schedule', 'archive', 'discard']),
})

export const SweepResponse = z.object({
  groups: z.array(
    z.object({
      category: z.string(),
      links: z.array(LinkRow),
    }),
  ),
})

export const SweepApplyResponse = z.object({ archived: z.number() })

export const MetricsResponse = z.object({
  stages: z.array(z.record(z.string(), z.unknown())),
  daily: z.array(z.record(z.string(), z.unknown())),
})

// ---- run -----------------------------------------------------------------

export const RunStageSummary = z.looseObject({
  okCount: z.number(),
  errorCount: z.number(),
})

export const RunResultBody = z.looseObject({
  runId: z.string(),
  cursorBefore: z.number(),
  cursorAfter: z.number(),
  summary: z.looseObject({
    ingest: z.looseObject({ jobs: z.array(IngestJobSummaryBody) }),
    extract: RunStageSummary,
    enrich: RunStageSummary,
    swept: z.number(),
    needsAction: z.boolean(),
    collections: CollectionsSummaryBody,
  }),
})

export const RunJournalBody = z.looseObject({
  id: z.number(),
  stage: z.string(),
  status: z.optional(z.string()),
  startedAt: z.string(),
  finishedAt: z.nullable(z.string()),
  inputCount: z.number(),
  okCount: z.number(),
  errorCount: z.number(),
  durationMs: z.nullable(z.number()),
  tokensIn: z.nullable(z.number()),
  tokensOut: z.nullable(z.number()),
  costUsd: z.nullable(z.number()),
})

// ---- events (SSE) ---------------------------------------------------------

export const LinkEventBody = z.looseObject({
  id: z.number(),
  linkId: z.number(),
  fromState: z.string(),
  toState: z.string(),
  event: z.string(),
  at: z.string(),
})

export const RunEventBody = z.looseObject({
  id: z.number(),
  stage: z.string(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.nullable(z.string()),
})

export const IngestEventBody = IngestStatusBody

// Re-exported for route param validation docs.
export { LINK_STATES }
