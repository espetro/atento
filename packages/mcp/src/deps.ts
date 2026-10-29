/**
 * Dependency wiring for the MCP server. `createMcpServer` takes a context
 * factory plus the injected extract/enrich functions, so tests can connect an
 * in-memory client over the same tools with fakes.
 */
import type {
  ExtractFn,
  EnrichFn,
  MetricsSummary,
  PipelineLogger,
  Store,
  SweepPlan,
  TriageResult,
  TtlConfig,
} from '@linkinbox/core'

export interface McpContext {
  store: Store
  ttl: TtlConfig
  logger: PipelineLogger
}

export interface McpDeps {
  /** Resolve the context. Called once per tool call; memoize if you want one store. */
  ctx(): Promise<McpContext>
  /**
   * The extraction function. The context is passed in so the adapter can
   * read the host policy (skip-list, canary state, saved profiles) from the
   * same store.
   */
  extractFn(ctx?: McpContext): Promise<ExtractFn>
  enrichFn(): Promise<EnrichFn>
  /** Release anything the context factory opened (stdio shutdown). */
  close?(): Promise<void>
}

/**
 * Tool name -> spec name mapping, e.g. `links_list` is `links.list`. MCP tool
 * names may not contain dots, so the spec names are mapped onto underscores.
 */
export const TOOL_NAME_MAP: Record<string, string> = {
  links_list: 'links.list',
  links_get: 'links.get',
  links_triage: 'links.triage',
  links_restore: 'links.restore',
  links_sweep: 'links.sweep',
  ingest_run: 'ingest.run',
  extract_run: 'extract.run',
  enrich_run: 'enrich.run',
  metrics_get: 'metrics.get',
  limits_status: 'limits.status',
}

export type SweepProposal = SweepPlan
export type MetricsResult = MetricsSummary
export type TriageResultShape = TriageResult
