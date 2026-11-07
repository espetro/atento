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
import { dirname, join } from 'node:path'
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
  type AsrFn,
  type BrowseFn,
  type BrowseOptions,
  type BrowseResult,
  type BrowserConfig,
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
  type LinkField,
  type LinkHistoryEntry,
  type LinkProjection,
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
import { existsSync } from 'node:fs'
import { loadLoginReport, type LoginReport, type PendingLoginPolicy } from './pending-logins.js'
import { createExtractFn } from './adapters/extract-fn.js'
import { createEnrichFn } from './adapters/enrich-fn.js'
import { createMediaFn, type MediaFn as AdapterMediaFn } from './adapters/media-fn.js'
import { createBrowseFn } from './adapters/browse-fn.js'
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
  browser?: BrowserConfig
  profilesDir?: string
  /** Config dir; the ingest spool lives at <dir>/spool. */
  dir?: string
  dbPath?: string
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
  /** The durable-ingest spool root, when the config dir is known. */
  readonly spoolDir?: string

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

  // ---- pipeline stages -------------------------------------------------
  extract(options?: ExtractStageOptions): Promise<ExtractResult>
  extractUntilEmpty(options?: ExtractUntilEmptyOptions): Promise<UntilEmptyResult>
  enrich(options?: EnrichStageOptions): Promise<EnrichResult>

  // ---- link operations --------------------------------------------------
  list(options?: ListLinksOptions): Promise<LinkProjection[]>
  get(id: number, fields?: LinkField[]): Promise<LinkProjection | null>
  history(id: number): Promise<LinkHistoryEntry[]>
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

interface ResolvedConfig {
  ttl: TtlConfig
  limits: LimitsConfig
  login: LoginConfig
  pacing: PacingConfig
  media: MediaConfig
  capture: CaptureConfig
  share: ShareConfig
  browser: BrowserConfig
  profilesDir: string
  dir: string
  dbPath?: string
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
    browser: normalizeBrowserConfig(config.browser ?? DEFAULT_BROWSER_CONFIG),
    profilesDir: config.profilesDir ?? '',
    dir: config.dir ?? '',
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
  const spoolDir = deps.spoolDir ?? (cfg.dir !== '' ? join(cfg.dir, 'spool') : undefined)

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
        // Rewrite only when the move actually happened: the new dir exists
        // and the old one is gone. Otherwise the path still resolves.
        if (existsSync(next) && !existsSync(profile.path)) {
          await store.upsertProfile({ host: profile.host, path: next })
        }
      }
    } catch {
      // Migration is best effort: a failure here must never block a run.
    }
  }

  const ops: LinkinboxOps = {
    store,
    config: cfg,
    logger,
    ...(spoolDir !== undefined ? { spoolDir } : {}),
    llmKey: LLM_KEY,

    extractFn() {
      extractFnPromise ??= (async () => {
        await ensureBrowserProfiles()
        return (
          deps.extractFn ??
          createExtractFn({
            profilesDir: cfg.profilesDir,
            limits: cfg.limits,
            login: cfg.login,
            pacing: cfg.pacing,
            browserConfig: cfg.browser,
            store,
          })
        )
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

    async extract(options = {}) {
      const fn = options.extract ?? (await ops.extractFn())
      const guard = options.guard === null ? undefined : (options.guard ?? ops.stageGuard())
      const media = options.media === null || options.media === undefined ? undefined : options.media
      return extract(store, {
        extract: fn,
        limit: options.limit,
        host: options.host,
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

    list(options) {
      return listLinks(store, options)
    },

    get(id, fields) {
      return getLink(store, id, fields)
    },

    history(id) {
      return linkHistory(store, id)
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
