/**
 * Dependency wiring for the MCP server. `createMcpServer` takes a context
 * factory plus the injected extract/enrich functions, so tests can connect an
 * in-memory client over the same tools with fakes.
 */
import type {
  BrowseFn,
  BrowseOptions,
  ExtractFn,
  EnrichFn,
  LimitsConfig,
  LoginConfig,
  MetricsSummary,
  PipelineLogger,
  ShareConfig,
  ShareHostEntry,
  Store,
  SweepPlan,
  TriageResult,
  TtlConfig,
} from '@linkinbox/app'

export interface McpContext {
  store: Store
  ttl: TtlConfig
  logger: PipelineLogger
  /**
   * Durable-ingest spool root (<config dir>/spool). When set, ingest_run
   * writes bulk input through ingest_jobs so a crash resumes from the
   * cursor; when absent the in-memory path runs (tests).
   */
  spoolDir?: string
  /** The config limits: the skip list and the review list. */
  limits?: LimitsConfig
  /** Which hosts may be logged in to (`[login] allow`). */
  login?: LoginConfig
  /**
   * The share allowlist (`[share] hosts`). When absent NOTHING is shared:
   * browse_read refuses every host, which is the default posture.
   */
  share?: ShareConfig
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
  /**
   * The read primitive for browse_read (the browser engines live in the
   * CLI package). When absent the tool reports that browsing is not
   * configured instead of opening a browser on its own.
   */
  browseFn?(ctx: McpContext): Promise<BrowseFn>
  /** The guard for browse_read: pacing, daily cap, working hours, breaker. */
  browseGuard?(ctx: McpContext): Promise<BrowseOptions['guard'] | undefined>
  /** True when the host has a saved browser profile (browse). */
  hasProfile?(host: string): Promise<boolean>
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
  links_overview: 'links.overview',
  links_pipeline: 'links.pipeline',
  ingest_run: 'ingest.run',
  ingest_file: 'ingest.file',
  ingest_text: 'ingest.text',
  ingest_urls: 'ingest.urls',
  ingest_remote: 'ingest.remote',
  ingest_status: 'ingest.status',
  collections_summary: 'collections.summary',
  collection_read: 'collections.read',
  collection_export: 'collections.export',
  extract_run: 'extract.run',
  enrich_run: 'enrich.run',
  metrics_get: 'metrics.get',
  limits_status: 'limits.status',
  login_pending: 'login.pending',
  browse_read: 'browse.read',
  browse_hosts: 'browse.hosts',
}

export type SweepProposal = SweepPlan
export type MetricsResult = MetricsSummary
export type TriageResultShape = TriageResult
