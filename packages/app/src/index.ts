/**
 * @linkinbox/app — the application layer.
 *
 * Use cases and the composition root (`createLinkinbox`) live here; the
 * driving adapters (cli, mcp, server) import only this package. The concrete
 * adapters — extractors, enrich, media, importers, the sqlite store — are
 * wired once inside `createLinkinboxOps` / `createLinkinbox`.
 */
export * from './config.js'
export * from './pending-logins.js'
export * from './adapters/extract-fn.js'
export * from './adapters/enrich-fn.js'
export * from './adapters/media-fn.js'
export * from './adapters/browse-fn.js'
export * from './linkinbox.js'
export * from './ingest-input.js'

// The shared contract surface the driving adapters render from. These are
// core domain values and shapers, re-exported so adapters never reach into
// @linkinbox/core for them.
export {
  LINK_STATES,
  LLM_KEY,
  MEDIA_TIERS,
  UI_SUMMARY_FIELDS,
  UI_DETAIL_FIELDS,
  DEFAULT_TTL_CONFIG,
  DEFAULT_LIMITS,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_LOGIN_CONFIG,
  DEFAULT_PACING,
  DEFAULT_MEDIA_CONFIG,
  DEFAULT_SHARE_CONFIG,
  DEFAULT_BROWSER_CONFIG,
  ACTION_TO_STATUS,
  parseRange,
  parseCapture,
  captureToken,
  tokensEqual,
  CaptureValidationError,
  CAPTURE_CONTENT_TYPES,
  TRUST_CAPTURED,
  TRUST_HEADLESS_PROFILE,
  TRUST_ANONYMOUS,
  shapeForUi,
  toPipelineRow,
  hostOf,
  hostPolicy,
  engineForHost,
  normalizeUrl,
  isStealthHost,
  isListedStealthHost,
  formatBatchSummary,
  formatTotals,
  guardDepsFromStore,
  guardStatuses,
  guardReset,
  pipelineLogger,
  setupLogging,
  disposeLogging,
  createCollectingLogger,
  noopLogger,
} from '@linkinbox/core'
export type {
  AsrFn,
  BusyRun,
  BrowseFn,
  BrowseOptions,
  BrowseResult,
  BrowserConfig,
  Capture,
  CaptureConfig,
  CaptureIngestResult,
  EnrichFn,
  Enrichment,
  ExtractFn,
  GuardConfig,
  GuardDeps,
  GuardStatus,
  HostState,
  HostPolicy,
  IngestJob,
  IngestJobStatus,
  IngestResult,
  LimitsConfig,
  Link,
  LinkField,
  LinkFilter,
  LinkHistoryEntry,
  LinkProjection,
  LinkState,
  LinkStateName,
  ListLinksOptions,
  LoginConfig,
  MediaConfig,
  MediaFn as CoreMediaFn,
  MediaReport as CoreMediaReport,
  MediaRun as CoreMediaRun,
  MediaTierName,
  MediaTierReport,
  MetricsSummary,
  PacingConfig,
  PipelineLogger,
  PipelineOverview,
  PipelineRow,
  PrunePlan,
  RawLink,
  RetryHeadlessResult,
  ShareConfig,
  ShareHostEntry,
  StageResult,
  Status,
  SweepPlan,
  SweepOpsOptions,
  TriageAction,
  TriageResult,
  TtlConfig,
  UntilEmptyBatchSummary,
  UntilEmptyResult,
} from '@linkinbox/core'
export type { Store } from '@linkinbox/core'
export type { SqliteStore } from '@linkinbox/db'
