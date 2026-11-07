/**
 * The application layer: use cases plus the composition root.
 *
 * `createLinkinbox(config)` is the single place where the concrete adapters
 * (extractors router, enrich package, media package, browser readers, the
 * SQLite store) are wired from config. The driving adapters — cli, mcp,
 * server — call the use cases on the returned object and never import the
 * adapter packages themselves.
 *
 * `createLinkinboxOps(config, deps)` is the same surface without the
 * store/config bootstrap, for adapters that already own a store (the http
 * server, tests).
 *
 * The shape is deliberately plain functions over injected deps: the port
 * interfaces land in M1 without reshaping this module.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { openStore } from '@linkinbox/db'
import { importFile, type ImportResult } from '@linkinbox/importers'
import {
  applyPrune,
  applySweep,
  browseRead,
  captureIngest,
  DEFAULT_BROWSER_CONFIG,
  normalizeBrowserConfig,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_LIMITS,
  DEFAULT_LOGIN_CONFIG,
  DEFAULT_MEDIA_CONFIG,
  DEFAULT_PACING,
  DEFAULT_SHARE_CONFIG,
  DEFAULT_TTL_CONFIG,
  enrich,
  enrichUntilEmpty,
  extract,
  extractUntilEmpty,
  guardDepsFromStore,
  guardReset,
  guardStatuses,
  ingest,
  listLinks,
  getLink,
  listShareHosts,
  listPipelineLinks,
  metricsSummary,
  pipelineOverview,
  prune,
  restore,
  resumeIngestJobs,
  retryHeadless,
  sweep,
  triage,
  linkHistory,
  LLM_KEY,
  migrateBrowserProfiles,
  noopLogger,
  remapLegacyProfilePath,
  DEFAULT_SERVER_CONFIG,
  type AsrFn,
  type BrowseFn,
  type BrowseOptions,
  type BrowseResult,
  type BrowserConfig,
  type BusyRun,
  type Capture,
  type CaptureConfig,
  type CaptureIngestResult,
  type EnrichFn,
  type EnrichResult,
  type ExtractFn,
  type ExtractResult,
  type GuardConfig,
  type GuardDeps,
  type GuardStatus,
  type HostState,
  type IngestResult,
  type LimitsConfig,
  type Link,
  type LinkField,
  type LinkHistoryEntry,
  type LinkOutcome,
  type LinkPatch,
  type LinkProjection,
  type LinkStateName,
  type ListLinksOptions,
  type LoginConfig,
  type MediaConfig,
  type MediaFn,
  type MetricsSummary,
  type PacingConfig,
  type PipelineListOptions,
  type PipelineLogger,
  type PipelineOverview,
  type PipelineRow,
  type PrunePlan,
  type RawLink,
  type RetryHeadlessResult,
  type Run,
  type ServerConfig,
  type ShareConfig,
  type ShareHostEntry,
  type Store,
  type SweepPlan,
  type SweepOpsOptions,
  type TriageAction,
  type TriageResult,
  type TtlConfig,
  type UntilEmptyOptions,
  type UntilEmptyResult,
} from '@linkinbox/core'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { loadLoginReport, type LoginReport, type PendingLoginPolicy } from './pending-logins.js'
import {
  ingestStatusOf,
  runIngestInput,
  type IngestInput,
  type IngestJobSummary,
  type IngestStatus,
} from './ingest-input.js'
import {
  collectionExport,
  collectionRead,
  collectionScan,
  collectionsSummary,
  type CollectionExportOptions,
  type CollectionExportResult,
  type CollectionName,
  type CollectionReadOptions,
  type CollectionReadResult,
  type CollectionScanResult,
  type CollectionsSummary,
} from './collections.js'
import { createExtractFn } from './adapters/extract-fn.js'
import { createEnrichFn } from './adapters/enrich-fn.js'
import { createMediaFn, type MediaFn as AdapterMediaFn } from './adapters/media-fn.js'
import { createBrowseFn } from './adapters/browse-fn.js'
import { randomUUID } from 'node:crypto'
import type { AppConfig } from './config.js'

/**
 * The config the use cases need. `AppConfig` satisfies this; adapters that
 * own their own bootstrap (the http server) pass only the fields they have
 * and the rest fall back to the core defaults — exactly what they did
 * before the app layer existed.
 */
export interface LinkinboxConfig {
  ttl?: TtlConfig
  limits?: LimitsConfig
  login?: LoginConfig
  pacing?: PacingConfig
  media?: MediaConfig
  capture?: CaptureConfig
  share?: ShareConfig
  /** HTTP server auth config (`[server]`); the server adapter reads it. */
  server?: ServerConfig
  browser?: BrowserConfig
  profilesDir?: string
  /** Config dir; the ingest spool lives at <dir>/spool. */
  dir?: string
  dbPath?: string
  /** Configured ingest sources (paths or URLs) that `run` ingests each pass. */
  sources?: string[]
}

/** Dependencies the ops factory cannot derive from config. */
export interface LinkinboxOpsDeps {
  /** The store the use cases run over. */
  store: Store
  /** Environment for the dynamic adapter loaders. Default process.env. */
  env?: NodeJS.ProcessEnv
  /** Logger for stage runs and importer warnings. Default noop. */
  logger?: PipelineLogger
  /** Pre-built adapter overrides (tests). */
  extractFn?: ExtractFn
  enrichFn?: EnrichFn
  mediaFn?: AdapterMediaFn
  asr?: AsrFn
  /** Spool root override; default <config.dir>/spool when dir is set. */
  spoolDir?: string
}

/** Options for `createLinkinbox`: injectable deps on top of the config. */
export type LinkinboxOptions = Omit<LinkinboxOpsDeps, 'store'> & {
  /** Inject a store instead of opening config.dbPath (tests, shared stores). */
  store?: Store
}

/** Options for the extract stage use case. */
export interface ExtractStageOptions {
  limit?: number
  /** Only process links of this host. */
  host?: string
  /** Injected extraction fn; default the wired router adapter. */
  extract?: ExtractFn
  /**
   * The guard. `undefined` builds the config guard (undefined itself when
   * limits are disabled); `null` runs unguarded; a GuardDeps is used as-is.
   */
  guard?: GuardDeps | null
  /** The media stage; absent runs without it (the default). */
  media?: MediaFn | null
  /**
   * Re-extract only these link ids (the reextract endpoint passes one).
   * Intersected with the `created` queue inside the extract stage.
   */
  linkIds?: number[]
  maxBatch?: number
  maxAttempts?: number
  leaseMs?: number
  logger?: PipelineLogger
  now?: () => Date
}

/** Options for the `--until-empty` variant of the extract stage. */
export interface ExtractUntilEmptyOptions extends ExtractStageOptions {
  maxIterations?: number
  sleep?: (ms: number) => Promise<void>
  onBatch?: UntilEmptyOptions['onBatch']
}

/** Options for the enrich stage use case. */
export interface EnrichStageOptions {
  limit?: number
  enrich?: EnrichFn
  guard?: GuardDeps | null
  maxBatch?: number
  maxAttempts?: number
  leaseMs?: number
  ttl?: TtlConfig
  logger?: PipelineLogger
  now?: () => Date
}

/** Options for the enrich `--until-empty` variant. */
export interface EnrichUntilEmptyStageOptions extends EnrichStageOptions {
  maxIterations?: number
  sleep?: (ms: number) => Promise<void>
  onBatch?: UntilEmptyOptions['onBatch']
}

/** Per-stage totals of one `run` pass, flattened for adapters. */
export interface RunStageSummary {
  batches: number
  /** Total links the stage saw across all batches. */
  input: number
  ok: number
  errors: number
  deferred: number
  needsBrowser: number
  hitCap: boolean
  /** Set when another run held this stage's lock; the stage did no work. */
  busy?: BusyRun
}

/** Options for the `run` use case: one full pipeline pass. */
export interface RunOptions {
  /** Extra local files to ingest this pass (alongside `[sources]`). */
  files?: string[]
  /** Cap per stage batch, forwarded to extract/enrich. */
  limit?: number
  maxIterations?: number
  /** Injected sleep for the drain loops (tests/CLI pass a no-op). */
  sleep?: (ms: number) => Promise<void>
  onBatch?: UntilEmptyOptions['onBatch']
  extract?: ExtractFn
  enrich?: EnrichFn
  media?: MediaFn | null
  guard?: GuardDeps | null
  logger?: PipelineLogger
  now?: () => Date
}

/** Options for the reextract use case (`POST /api/links/:id/reextract`). */
export interface ReextractOptions {
  /**
   * Force one browser adapter id. Honoured only by the config-wired
   * extract fn: an injected `extractFn` dep (tests) cannot pick adapters
   * and is used as-is.
   */
  adapter?: string
  /** Cap forwarded to the extract stage. */
  limit?: number
}

/** Outcome of `reextractLink`. */
export type ReextractResult =
  | {
      ok: true
      linkId: number
      /** The extract stage's outcome row for this link, when it ran. */
      outcome?: LinkOutcome
      /** The link's FSM state after the call. */
      state: string | null
    }
  | {
      ok: false
      reason: 'not_found' | 'deleted' | 'illegal_state' | 'busy' | 'error'
      /** The link's FSM state when the refusal is state-dependent. */
      state?: string
      message?: string
      /** Set when another extract run held the stage lock. */
      busy?: BusyRun
    }

/** One artifact file stored for a link (screenshot, snapshot, ...). */
export interface ArtifactContent {
  name: string
  contentType: string
  body: Uint8Array
}

/** What `run` returns: cursors bracketing the pass plus per-stage totals. */
export interface RunResult {
  /** Unique id for this pass (`run-<uuid>`), for logs and harness records. */
  runId: string
  /** link_events cursor before the pass started. */
  cursorBefore: number
  /** link_events cursor after the pass finished (the next `since`). */
  cursorAfter: number
  summary: {
    /** One job summary per ingested source/file (payloads never echoed). */
    ingest: { jobs: IngestJobSummary[] }
    extract: RunStageSummary
    enrich: RunStageSummary
    /** Links the sweep archived this pass. */
    swept: number
    /**
     * True when the pass finished but left work only the user can do:
     * needs_login, blocked or errored links remain. Maps to exit code 2.
     */
    needsAction: boolean
    /** The collections view after the pass — what a harness reads next. */
    collections: CollectionsSummary
  }
}

/** Options for the ingest-files use case. */
export interface IngestFilesOptions {
  limit?: number
  logger?: PipelineLogger
  now?: () => Date
  /** Per-file callback (the cli prints one line per file). */
  onFile?: (file: string, result: ImportResult & { importer: string }) => void
}

export interface IngestFilesResult {
  outcome: IngestResult
  warnings: string[]
  importers: Record<string, number>
  files: { file: string; importer: string; count: number }[]
}

/** One resumed ingest job outcome plus its job row. */
export type { IngestJobRunResult } from '@linkinbox/core'

/**
 * The application surface the driving adapters consume. Every member is a
 * use case bound to the store and config the composition root resolved.
 */
export interface LinkinboxOps {
  readonly store: Store
  readonly config: Required<Omit<LinkinboxConfig, 'dbPath'>> & { dbPath?: string }
  readonly logger: PipelineLogger
  /** The durable-ingest spool root. */
  readonly spoolDir: string
  /** The collection export root: <config dir>/exports (or next to the db). */
  readonly exportsDir: string
  /** The link-artifact root: <config dir>/artifacts (or next to the db). */
  readonly artifactsDir: string

  // ---- adapter functions (lazy, memoized, config-wired) -------------
  extractFn(): Promise<ExtractFn>
  enrichFn(): Promise<EnrichFn>
  mediaFn(): Promise<AdapterMediaFn>
  browseFn(): Promise<BrowseFn>
  /** The browse guard: pacing, daily cap, working hours, breaker. */
  browseGuard(): GuardDeps

  // ---- guards --------------------------------------------------------
  /** guardDepsFromStore over this store; undefined config values are dropped. */
  guardDeps(config?: Partial<GuardConfig>): GuardDeps
  /**
   * The pipeline-stage guard: undefined when limits are disabled, else the
   * store-backed guard over limits + pacing + [login].
   */
  stageGuard(): GuardDeps | undefined

  // ---- ingest ---------------------------------------------------------
  /** Finish ingest jobs a previous run left behind (crash resume). */
  resumeIngest(options?: { limit?: number; logger?: PipelineLogger }): ReturnType<typeof resumeIngestJobs>
  /** Import files, then ingest the raw links (spooled when configured). */
  ingestFiles(files: string[], options?: IngestFilesOptions): Promise<IngestFilesResult>
  /** Ingest pre-parsed raw links. */
  ingestRaws(raws: RawLink[], options?: { limit?: number; logger?: PipelineLogger; now?: () => Date; spoolDir?: string }): Promise<IngestResult>
  /**
   * The M2 bulk-ingest use case shared by CLI, MCP and the HTTP API. Every
   * input kind resolves to RawLinks spooled through ingest_jobs; the result
   * is a job summary only — link payloads are never echoed back.
   */
  ingest(input: IngestInput, options?: { logger?: PipelineLogger; now?: () => Date }): Promise<IngestJobSummary>
  /** Progress for one ingest job (null when the id is unknown). */
  ingestStatus(jobId: string): Promise<IngestStatus | null>

  // ---- collections (token-efficient output) ------------------------------
  /** Counts per collection plus the needs_login per-host breakdown. */
  collectionsSummary(): Promise<CollectionsSummary>
  /** Inline paginated read of one collection; `since` is a link_events cursor. */
  collectionRead(name: CollectionName, options?: CollectionReadOptions): Promise<CollectionReadResult>
  /**
   * Full scan of one collection (or its delta): every matching row, no
   * pagination cap. Backs the streaming HTTP formats (jsonl/md).
   */
  collectionScan(
    name: CollectionName,
    options?: { since?: number; fields?: readonly string[] },
  ): Promise<CollectionScanResult>
  /** Write one collection (or its delta) to an export file; returns a handle. */
  collectionExport(
    name: CollectionName,
    options?: Omit<CollectionExportOptions, 'exportsDir'>,
  ): Promise<CollectionExportResult>

  // ---- pipeline stages -------------------------------------------------
  extract(options?: ExtractStageOptions): Promise<ExtractResult>
  extractUntilEmpty(options?: ExtractUntilEmptyOptions): Promise<UntilEmptyResult>
  enrich(options?: EnrichStageOptions): Promise<EnrichResult>
  enrichUntilEmpty(options?: EnrichUntilEmptyStageOptions): Promise<UntilEmptyResult>

  /**
   * One full pipeline pass (M2): ingest the configured `[sources]` plus any
   * `files` argument, extract until empty, enrich until empty, then sweep.
   * Returns cursors bracketing the pass and a per-stage summary; `busy`
   * marks whichever stage lock another run held.
   */
  run(options?: RunOptions): Promise<RunResult>

  // ---- link operations --------------------------------------------------
  list(options?: ListLinksOptions): Promise<LinkProjection[]>
  get(id: number, fields?: LinkField[]): Promise<LinkProjection | null>
  history(id: number): Promise<LinkHistoryEntry[]>
  /**
   * Patch user-editable link fields (title, note, tags). Returns the
   * updated link, or null when the id is unknown. State changes never go
   * through here — they are FSM events.
   */
  patchLink(id: number, patch: LinkPatch): Promise<Link | null>
  /** One `runs` journal row by id (null when unknown). */
  getRun(id: number): Promise<Run | null>
  /**
   * Delta read of the link_events log: the resumable cursor stream behind
   * `GET /api/events`. `since` is the last seen event id.
   */
  listEvents(since?: number, limit?: number): Promise<LinkHistoryEntry[]>
  /**
   * Read one artifact stored for a link (screenshots/snapshots land under
   * <artifactsDir>/<linkId>/<name>). Null when absent or the name escapes
   * the link's directory.
   */
  readArtifact(linkId: number, name: string): Promise<ArtifactContent | null>
  /**
   * Re-extract one link: RETRY it back to the `created` queue when its FSM
   * state allows, then run the extract stage scoped to that link only.
   * `adapter` forces one browser adapter through the wired extract fn.
   */
  reextractLink(id: number, options?: ReextractOptions): Promise<ReextractResult>
  triage(ids: number[], action: TriageAction): Promise<TriageResult>
  restore(ids: number[], now?: Date): Promise<{ requested: number[]; updated: number; missing: number[]; blocked: number[] }>
  retryHeadless(ids: number[], now?: Date): Promise<RetryHeadlessResult>
  overview(options?: { topHosts?: number }): Promise<PipelineOverview>
  pipelineLinks(options?: PipelineListOptions): Promise<PipelineRow[]>
  metrics(range?: string, now?: Date): Promise<MetricsSummary>
  sweepPlan(ttl?: TtlConfig, options?: SweepOpsOptions): Promise<SweepPlan>
  applySweepPlan(plan: SweepPlan, now?: Date): Promise<number>
  prunePlan(ttl?: TtlConfig, options?: SweepOpsOptions): Promise<PrunePlan>
  applyPrunePlan(plan: PrunePlan): Promise<number>
  guardStatusesFor(keys: string[]): Promise<GuardStatus[]>
  guardResetFor(key: string): Promise<HostState>
  /** The llm guard key, re-exported for adapters that enumerate hosts. */
  readonly llmKey: string

  // ---- login / browse / capture ----------------------------------------
  /** The pending-logins report (read-only). */
  loginPending(policy?: PendingLoginPolicy): Promise<LoginReport>
  /** Read one page through the host's saved profile (read-only). */
  browseRead(url: string, options?: Partial<BrowseOptions> & { share?: ShareConfig }): Promise<BrowseResult>
  /** Which saved profiles are shareable, and why not. */
  browseHosts(profiles?: { host: string }[], share?: ShareConfig): Promise<ShareHostEntry[]>
  /** Ingest one client capture (the /capture endpoint's write path). */
  captureIngest(capture: Capture): Promise<CaptureIngestResult>
}

/** The full application: ops plus lifecycle. */
export interface Linkinbox extends LinkinboxOps {
  /** Release what the composition root opened (the store, when owned). */
  close(): Promise<void>
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Content type for an artifact file name, by extension. */
function artifactContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'svg': return 'image/svg+xml'
    case 'pdf': return 'application/pdf'
    case 'json': return 'application/json; charset=utf-8'
    case 'txt':
    case 'md': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

interface ResolvedConfig {
  ttl: TtlConfig
  limits: LimitsConfig
  login: LoginConfig
  pacing: PacingConfig
  media: MediaConfig
  capture: CaptureConfig
  share: ShareConfig
  server: ServerConfig
  browser: BrowserConfig
  profilesDir: string
  dir: string
  dbPath?: string
  sources: string[]
}

function resolveConfig(config: LinkinboxConfig): ResolvedConfig {
  return {
    ttl: config.ttl ?? DEFAULT_TTL_CONFIG,
    limits: config.limits ?? DEFAULT_LIMITS,
    login: config.login ?? DEFAULT_LOGIN_CONFIG,
    pacing: config.pacing ?? DEFAULT_PACING,
    media: config.media ?? DEFAULT_MEDIA_CONFIG,
    capture: config.capture ?? DEFAULT_CAPTURE_CONFIG,
    share: config.share ?? DEFAULT_SHARE_CONFIG,
    server: config.server ?? DEFAULT_SERVER_CONFIG,
    browser: normalizeBrowserConfig(config.browser ?? DEFAULT_BROWSER_CONFIG),
    profilesDir: config.profilesDir ?? '',
    dir: config.dir ?? '',
    sources: config.sources ?? [],
    ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
  }
}

/** Drop undefined values so they never replace a GuardConfig default. */
function cleanGuardConfig(config: Partial<GuardConfig>): Partial<GuardConfig> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<GuardConfig>
}

/**
 * Build the use-case surface over an already-open store. Synchronous: the
 * adapter functions are built lazily on first use, so constructing the app
 * never touches the network or spawns a browser.
 */
export function createLinkinboxOps(
  config: LinkinboxConfig,
  deps: LinkinboxOpsDeps,
): LinkinboxOps {
  const cfg = resolveConfig(config)
  const store = deps.store
  const env = deps.env ?? process.env
  const logger = deps.logger ?? noopLogger
  // The ingest spool always resolves: <config dir>/spool, else next to the
  // db, else the OS temp dir — bulk ingest is durable on every adapter.
  const spoolDir =
    deps.spoolDir ??
    (cfg.dir !== ''
      ? join(cfg.dir, 'spool')
      : cfg.dbPath !== undefined
        ? join(dirname(cfg.dbPath), 'spool')
        : join(tmpdir(), 'linkinbox-spool'))
  const exportsDir =
    cfg.dir !== ''
      ? join(cfg.dir, 'exports')
      : cfg.dbPath !== undefined
        ? join(dirname(cfg.dbPath), 'exports')
        : join(tmpdir(), 'linkinbox-exports')
  const artifactsDir =
    cfg.dir !== ''
      ? join(cfg.dir, 'artifacts')
      : cfg.dbPath !== undefined
        ? join(dirname(cfg.dbPath), 'artifacts')
        : join(tmpdir(), 'linkinbox-artifacts')

  // Lazily built, memoized adapter functions.
  let extractFnPromise: Promise<ExtractFn> | undefined
  let enrichFnPromise: Promise<EnrichFn> | undefined
  let mediaFnPromise: Promise<AdapterMediaFn> | undefined
  let browseFnPromise: Promise<BrowseFn> | undefined
  let profilesMigrated = false

  /**
   * One-time browser profile migration (M1): move legacy
   * <profiles>/<host> and <profiles>/<host>/patchright directories into
   * the per-adapter <profiles>/<host>/<adapterId> layout and rewrite the
   * stored profile paths to match. Idempotent; runs before the first
   * browser-touching adapter is built.
   */
  async function ensureBrowserProfiles(): Promise<void> {
    if (profilesMigrated || cfg.profilesDir === '') return
    profilesMigrated = true
    try {
      migrateBrowserProfiles(cfg.profilesDir, cfg.browser, (m) => logger.info(m))
      for (const profile of await store.listProfiles()) {
        const next = remapLegacyProfilePath(cfg.profilesDir, cfg.browser, profile.path)
        if (next === undefined || next === profile.path) continue
        // Rewrite whenever the migrated target exists. The legacy source
        // may still exist — <profiles>/<host> remains as the parent of the
        // new <host>/<adapterId> dirs — so its existence proves nothing.
        if (existsSync(next)) {
          await store.upsertProfile({ host: profile.host, path: next })
        }
      }
    } catch {
      // Migration is best effort: a failure here must never block a run.
    }
  }

  /** The createExtractFn options shared by the memoized and forced fns. */
  function extractFnOptions(forceAdapterId?: string) {
    return {
      profilesDir: cfg.profilesDir,
      limits: cfg.limits,
      login: cfg.login,
      pacing: cfg.pacing,
      browserConfig: cfg.browser,
      store,
      ...(forceAdapterId !== undefined ? { forceAdapterId } : {}),
    }
  }

  const ops: LinkinboxOps = {
    store,
    config: cfg,
    logger,
    spoolDir,
    exportsDir,
    artifactsDir,
    llmKey: LLM_KEY,

    extractFn() {
      extractFnPromise ??= (async () => {
        await ensureBrowserProfiles()
        return deps.extractFn ?? createExtractFn(extractFnOptions())
      })()
      return extractFnPromise
    },

    enrichFn() {
      enrichFnPromise ??= Promise.resolve(deps.enrichFn ?? createEnrichFn({ env }))
      return enrichFnPromise
    },

    mediaFn() {
      mediaFnPromise ??= (async () => {
        if (deps.mediaFn) return deps.mediaFn
        const limits = cfg.limits ?? DEFAULT_LIMITS
        const guard =
          limits.disabled === true
            ? undefined
            : guardDepsFromStore(store, {
                config: { limits, pacing: cfg.pacing },
              })
        return createMediaFn({
          env,
          config: cfg.media,
          guard,
          asr: deps.asr,
          store,
        })
      })()
      return mediaFnPromise
    },

    browseFn() {
      browseFnPromise ??= (async () => {
        await ensureBrowserProfiles()
        return createBrowseFn({
          share: cfg.share,
          browser: cfg.browser,
          profilesDir: cfg.profilesDir,
        })
      })()
      return browseFnPromise
    },

    browseGuard() {
      return guardDepsFromStore(store, {
        config: { limits: cfg.limits, pacing: cfg.pacing },
      })
    },

    guardDeps(config = {}) {
      return guardDepsFromStore(store, { config: cleanGuardConfig(config) })
    },

    stageGuard() {
      const limits = cfg.limits ?? DEFAULT_LIMITS
      if (limits.disabled === true) return undefined
      return guardDepsFromStore(store, {
        config: {
          limits,
          pacing: cfg.pacing,
          ...(cfg.login ? { login: cfg.login } : {}),
        },
      })
    },

    resumeIngest(options = {}) {
      return resumeIngestJobs(store, {
        logger: options.logger ?? logger,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
    },

    async ingestFiles(files, options = {}) {
      const warnings: string[] = []
      const importers: Record<string, number> = {}
      const perFile: IngestFilesResult['files'] = []
      const raws: RawLink[] = []
      for (const file of files) {
        const result = await importFile(file)
        warnings.push(...result.warnings)
        raws.push(...result.links)
        importers[result.importer] = (importers[result.importer] ?? 0) + result.links.length
        perFile.push({ file, importer: result.importer, count: result.links.length })
        options.onFile?.(file, result)
      }
      const outcome = await ingest(store, raws, {
        logger: options.logger ?? logger,
        limit: options.limit,
        ...(options.now ? { now: options.now } : {}),
        ...(spoolDir !== undefined ? { spoolDir } : {}),
      })
      return { outcome, warnings, importers, files: perFile }
    },

    ingestRaws(raws, options = {}) {
      const dir = options.spoolDir !== undefined ? options.spoolDir : spoolDir
      return ingest(store, raws, {
        logger: options.logger ?? logger,
        limit: options.limit,
        ...(options.now ? { now: options.now } : {}),
        ...(dir !== undefined ? { spoolDir: dir } : {}),
      })
    },

    ingest(input, options = {}) {
      return runIngestInput(store, input, {
        spoolDir,
        logger: options.logger ?? logger,
        ...(options.now ? { now: options.now } : {}),
      })
    },

    async ingestStatus(jobId) {
      const job = await store.getIngestJob(jobId)
      return job === null ? null : ingestStatusOf(job)
    },

    collectionsSummary() {
      return collectionsSummary(store)
    },

    collectionRead(name, options = {}) {
      return collectionRead(store, name, options)
    },

    collectionScan(name, options = {}) {
      return collectionScan(store, name, options)
    },

    collectionExport(name, options = {}) {
      return collectionExport(store, name, { ...options, exportsDir })
    },

    async extract(options = {}) {
      const fn = options.extract ?? (await ops.extractFn())
      const guard = options.guard === null ? undefined : (options.guard ?? ops.stageGuard())
      const media = options.media === null || options.media === undefined ? undefined : options.media
      return extract(store, {
        extract: fn,
        limit: options.limit,
        host: options.host,
        ...(options.linkIds !== undefined ? { linkIds: options.linkIds } : {}),
        guard,
        maxBatch: options.maxBatch ?? cfg.limits.maxBatch,
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        ...(media ? { media } : {}),
        logger: options.logger ?? logger,
        ...(options.now ? { now: options.now } : {}),
      })
    },

    async extractUntilEmpty(options = {}) {
      const fn = options.extract ?? (await ops.extractFn())
      const guard = options.guard === null ? undefined : (options.guard ?? ops.stageGuard())
      const media = options.media === null || options.media === undefined ? undefined : options.media
      return extractUntilEmpty(store, {
        extract: fn,
        limit: options.limit,
        host: options.host,
        ...(options.linkIds !== undefined ? { linkIds: options.linkIds } : {}),
        guard,
        maxBatch: options.maxBatch ?? cfg.limits.maxBatch,
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        ...(media ? { media } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.onBatch ? { onBatch: options.onBatch } : {}),
        logger: options.logger ?? logger,
        ...(options.now ? { now: options.now } : {}),
      })
    },

    async enrich(options = {}) {
      const fn = options.enrich ?? (await ops.enrichFn())
      const guard = options.guard === null ? undefined : (options.guard ?? ops.stageGuard())
      return enrich(store, {
        enrich: fn,
        limit: options.limit,
        guard,
        maxBatch: options.maxBatch ?? cfg.limits.maxBatch,
        ttl: options.ttl ?? cfg.ttl,
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        logger: options.logger ?? logger,
        ...(options.now ? { now: options.now } : {}),
      })
    },

    async enrichUntilEmpty(options = {}) {
      const fn = options.enrich ?? (await ops.enrichFn())
      const guard = options.guard === null ? undefined : (options.guard ?? ops.stageGuard())
      return enrichUntilEmpty(store, {
        enrich: fn,
        limit: options.limit,
        guard,
        maxBatch: options.maxBatch ?? cfg.limits.maxBatch,
        ttl: options.ttl ?? cfg.ttl,
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.onBatch ? { onBatch: options.onBatch } : {}),
        logger: options.logger ?? logger,
        ...(options.now ? { now: options.now } : {}),
      })
    },

    async run(options = {}) {
      const runId = `run-${randomUUID()}`
      const runLogger = options.logger ?? logger
      const cursorBefore = await store.linkEventCursor()

      // 1. Ingest: configured [sources] plus any file arguments. Each goes
      //    through the durable spool; a busy ingest lock stops the pass's
      //    ingest half but never blocks the pipeline stages.
      const jobs: IngestJobSummary[] = []
      // Crash resume first: jobs a previous run left in the spool finish
      // before this pass ingests anything new.
      await ops.resumeIngest({ logger: runLogger })
      const sources = [...cfg.sources, ...(options.files ?? [])]
      for (const source of sources) {
        const input: IngestInput = /^https?:\/\//i.test(source)
          ? { kind: 'remote', url: source }
          : { kind: 'file', path: source }
        const summary = await ops.ingest(input, { logger: runLogger })
        jobs.push(summary)
        if (summary.busy) break
      }

      // 2./3. Drain extract then enrich. Each stage keeps its own lock, so
      //    a busy extract does not stop enrich from running. `guard` is
      //    forwarded untouched: undefined means the config guard, null
      //    means unguarded.
      const extractResult = await ops.extractUntilEmpty({
        ...(options.extract ? { extract: options.extract } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.media !== undefined ? { media: options.media } : {}),
        ...(options.guard !== undefined ? { guard: options.guard } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.onBatch ? { onBatch: options.onBatch } : {}),
        logger: runLogger,
        ...(options.now ? { now: options.now } : {}),
      })
      const enrichResult = await ops.enrichUntilEmpty({
        ...(options.enrich ? { enrich: options.enrich } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.guard !== undefined ? { guard: options.guard } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.onBatch ? { onBatch: options.onBatch } : {}),
        logger: runLogger,
        ...(options.now ? { now: options.now } : {}),
      })

      // 4. Sweep stale links into the archive.
      const plan = await ops.sweepPlan(cfg.ttl, options.now ? { now: options.now() } : {})
      const swept = await ops.applySweepPlan(plan, options.now?.() ?? new Date())

      const stageSummary = (r: UntilEmptyResult): RunStageSummary => ({
        batches: r.batches.length,
        input: r.batches.reduce((n, b) => n + b.inputCount, 0),
        ok: r.totals.ok,
        errors: r.totals.errors,
        deferred: r.totals.deferred,
        needsBrowser: r.totals.needsBrowser,
        hitCap: r.hitCap,
        ...(r.busy ? { busy: r.busy } : {}),
      })

      const collections = await ops.collectionsSummary()
      const needsAction =
        collections.collections.needs_login +
          collections.collections.blocked +
          collections.collections.errored >
        0
      const cursorAfter = await store.linkEventCursor()

      runLogger.info('run {runId} finished: cursor {cursorBefore} -> {cursorAfter}', {
        runId,
        cursorBefore,
        cursorAfter,
      })
      return {
        runId,
        cursorBefore,
        cursorAfter,
        summary: {
          ingest: { jobs },
          extract: stageSummary(extractResult),
          enrich: stageSummary(enrichResult),
          swept,
          needsAction,
          collections,
        },
      }
    },

    list(options) {
      return listLinks(store, options)
    },

    get(id, fields) {
      return getLink(store, id, fields)
    },

    history(id) {
      return linkHistory(store, id)
    },

    async patchLink(id, patch) {
      const existing = await store.getLink(id)
      if (!existing) return null
      // Only the user-editable columns: anything else in the patch is a
      // caller bug, not a write.
      const allowed: LinkPatch = {}
      if (patch.title !== undefined) allowed.title = patch.title
      if (patch.note !== undefined) allowed.note = patch.note
      if (patch.tags !== undefined) allowed.tags = patch.tags
      await store.patchLink(id, allowed)
      return store.getLink(id)
    },

    getRun(id) {
      return store.getRun(id)
    },

    listEvents(since, limit) {
      return store.listLinkEvents(since ?? 0, limit)
    },

    async readArtifact(linkId, name) {
      // Artifact names are single file names: no separators, no dotfiles
      // tricks, no traversal. Anything else is simply absent.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) return null
      const dir = resolve(artifactsDir, String(linkId))
      const path = resolve(dir, name)
      if (!path.startsWith(dir + sep)) return null
      try {
        if (!statSync(path).isFile()) return null
        return { name, contentType: artifactContentType(name), body: readFileSync(path) }
      } catch {
        return null
      }
    },

    async reextractLink(id, options = {}) {
      const link = await store.getLink(id)
      if (!link) return { ok: false, reason: 'not_found' } as const
      const stateName = link.state as LinkStateName
      if (stateName === 'deleted') {
        return { ok: false, reason: 'deleted', state: stateName } as const
      }
      // Requeue through the FSM: RETRY sends extracted/needs_browser/
      // deferred/errored/inbox links back to `created`. States without a
      // RETRY edge (scheduled, archived, discarded, leased) refuse.
      if (stateName !== 'created') {
        const retry = await store.applyEvent(id, {
          type: 'RETRY',
          stage: 'extract',
          at: new Date().toISOString(),
        })
        if (!retry.ok) {
          return {
            ok: false,
            reason: 'illegal_state',
            state: stateName,
            message: retry.error.message,
          } as const
        }
      }
      // An explicit adapter builds a fresh forced-adapter fn (the memoized
      // one cannot switch engines per call). An injected extractFn dep
      // cannot honour adapter ids and is used as-is.
      let extract: ExtractFn | undefined
      if (options.adapter !== undefined && deps.extractFn === undefined) {
        try {
          await ensureBrowserProfiles()
          extract = createExtractFn(extractFnOptions(options.adapter))
        } catch (err) {
          return {
            ok: false,
            reason: 'error',
            state: stateName,
            message: errMsg(err),
          } as const
        }
      }
      const result = await ops.extract({
        linkIds: [id],
        ...(extract !== undefined ? { extract } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })
      if (result.busy) {
        return { ok: false, reason: 'busy', busy: result.busy } as const
      }
      const after = await store.getLink(id)
      return {
        ok: true,
        linkId: id,
        outcome: result.outcomes.find((o) => o.linkId === id),
        state: after?.state ?? null,
      } as const
    },

    triage(ids, action) {
      return triage(store, ids, action)
    },

    restore(ids, now) {
      return restore(store, ids, now)
    },

    retryHeadless(ids, now) {
      return retryHeadless(store, ids, now)
    },

    overview(options) {
      return pipelineOverview(store, options)
    },

    pipelineLinks(options) {
      return listPipelineLinks(store, options)
    },

    metrics(range, now) {
      return metricsSummary(store, range, now)
    },

    sweepPlan(ttl, options) {
      return sweep(store, ttl ?? cfg.ttl, options)
    },

    applySweepPlan(plan, now) {
      return applySweep(store, plan, now)
    },

    prunePlan(ttl, options) {
      return prune(store, ttl ?? cfg.ttl, options)
    },

    applyPrunePlan(plan) {
      return applyPrune(store, plan)
    },

    guardStatusesFor(keys) {
      return guardStatuses(ops.guardDeps(), keys)
    },

    guardResetFor(key) {
      return guardReset(ops.guardDeps(), key)
    },

    loginPending(policy) {
      return loadLoginReport(store, policy)
    },

    async browseRead(url, options = {}) {
      const read = options.read ?? (await ops.browseFn())
      return browseRead(url, {
        share: options.share ?? cfg.share,
        read,
        hasProfile:
          options.hasProfile ??
          (async (host) => (await store.getProfile(host)) !== null),
        // An explicit `guard` key (even undefined) wins; absent means the
        // config guard. This mirrors the adapters' old wiring exactly.
        guard: 'guard' in options ? options.guard : ops.browseGuard(),
      })
    },

    async browseHosts(profiles, share) {
      const rows = profiles ?? (await store.listProfiles())
      return listShareHosts(rows, share ?? cfg.share)
    },

    captureIngest(capture) {
      return captureIngest(store, capture)
    },
  }

  return ops
}

/**
 * The composition root: resolve the config, open the store (unless one is
 * injected) and build the use-case surface. This is the ONLY place the
 * concrete adapters are wired.
 */
export async function createLinkinbox(
  config: AppConfig,
  options: LinkinboxOptions = {},
): Promise<Linkinbox> {
  const env = options.env ?? process.env
  const effective = config
  mkdirSync(dirname(effective.dbPath), { recursive: true })
  const ownsStore = options.store === undefined
  const store: Store =
    options.store ?? (await openStore({ path: effective.dbPath }))

  const ops = createLinkinboxOps(effective, { ...options, store, env })

  return {
    ...ops,
    async close() {
      // An injected store belongs to the caller: only close what we opened.
      if (ownsStore) await store.close()
    },
  }
}
