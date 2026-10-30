import type { Store } from '../store.js'
import type { Link } from '../types.js'
import type { StageResult, StageOptions, LinkOutcome, ExtractFn } from './types.js'
import { STAGES, noopLogger } from './types.js'
import { recordRunMetrics } from './ingest.js'
import {
  DEFAULT_MAX_BATCH,
  breakerReport,
  emptyHostState,
  hostPolicy,
  isLoginWall,
  markFlagged,
  markOpen,
  pacingSignalMs,
  trialStateOf,
  type GuardDeps,
  guardRun,
} from '../resilience/index.js'
import {
  attemptsOf,
  deferOrError,
  guardDepsFromStore,
  hostOf,
  releaseDueDeferred,
} from './resilience.js'
import { isMediaLink, type MediaFn, type MediaRun } from '../media.js'
import { DEFAULT_MAX_ATTEMPTS } from './resilience-options.js'

/** The reason recorded on links parked because their host is skip-listed. */
export const SKIP_HOST_REASON = 'skip_host'
/** The reason recorded on links parked behind a login wall. */
export const LOGIN_WALL_REASON = 'login_wall'

export interface ExtractOptions extends StageOptions {
  /** Injected extraction function (the CLI adapts the extractors router). */
  extract: ExtractFn
  /** Cap the number of links processed in this run. */
  limit?: number
  /** Only process links of this host (canary runs, one site at a time). */
  host?: string
  /**
   * How long a lease may be held before another runner reclaims it. Leases
   * older than this are returned to the `created` queue before the batch is
   * selected. Default: 30 minutes.
   */
  leaseMs?: number
  /**
   * Resilience wiring: limiter + breaker + retry per host. When absent the
   * stage runs unguarded exactly as before (backward compatible).
   */
  guard?: GuardDeps
  /** Max DEFER rounds before a link moves to errored. Default 5. */
  maxAttempts?: number
  /** Hard cap on links per call when invoked remotely. Default 20. */
  maxBatch?: number
  /**
   * The tiered media stage, injected by the caller. When present, links whose
   * extracted metadata or URL marks them as video get a media run after a
   * successful extraction and the report is attached to the link. A media
   * failure never fails the link.
   */
  media?: MediaFn
}

export interface ExtractResult extends StageResult {
  /** Number of links that ended up flagged needs_browser. */
  needsBrowserCount: number
  /** Number of links deferred by the limiter or breaker (additive). */
  deferredCount: number
  /** Suggested wait in ms before the next batch should run (additive). */
  retryAfter: number
  /** Number of links parked (discarded) because their host is skip-listed. */
  skippedHostCount: number
  /** Number of links the media stage ran for (additive). */
  mediaCount: number
  /** Hosts whose canary was tried in this run: host -> flag/open. */
  canaryTrials: Record<string, 'open' | 'flagged'>
}

/**
 * Extract stage: claim `created` links by atomically transitioning them to
 * `extracting` (the compare-and-set guarantees a link is never claimed by two
 * runners), run extraction, then record the outcome as one FSM event.
 *
 * A link whose extraction cannot run locally (walled garden, missing browser
 * profile, network failure) moves to `needs_browser` instead of crashing the
 * stage: the link is counted as ok-with-flag so the run stays green.
 *
 * With a guard, every fetch is rate limited per host and protected by the
 * host's circuit breaker. A throttled or blocked link gets a DEFER event
 * (never an error), and the rest of that host's batch is deferred too.
 */
export async function extract(store: Store, options: ExtractOptions): Promise<ExtractResult> {
  const logger = options.logger ?? noopLogger
  const now = options.now ?? (() => new Date())
  const startedAt = now()
  const guard: GuardDeps | undefined = options.guard
  const guardActive = guard !== undefined
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH

  // Reclaim leases from a previous run that died, so a killed process never
  // strands a link.
  const leaseMs = options.leaseMs ?? 30 * 60 * 1000
  await store.reclaimExpiredLeases(new Date(startedAt.getTime() - leaseMs))

  // Due deferred links come back to the created queue before selection.
  await releaseDueDeferred(store, 'extract', startedAt)

  const queued = options.host
    ? (await store.listByStates(['created'])).filter((link) => hostOf(link.url) === options.host)
    : await store.listByStates(['created'], options.limit)
  const batch = queued.slice(0, options.limit ?? maxBatch).slice(0, maxBatch)
  const run = await store.startRun(STAGES.extract, batch.length, startedAt)
  logger.info('extract run {runId} started with {inputCount} links', {
    runId: run.id,
    inputCount: batch.length,
  })

  const outcomes: LinkOutcome[] = []
  let okCount = 0
  let errorCount = 0
  let needsBrowserCount = 0
  let deferredCount = 0
  let skippedHostCount = 0
  let mediaCount = 0
  let retryAfter = 0
  const errorsByExtractor = new Map<string, number>()
  const needsBrowserByExtractor = new Map<string, number>()
  const extractionsByExtractor = new Map<string, number>()
  /** Set when a host's breaker opens: the rest of its links are deferred. */
  const blockedHosts = new Set<string>()
  /** Deferral count per host, for the tagged resilience metrics. */
  const deferralsByHost = new Map<string, number>()
  const bumpDeferral = (host: string): void => {
    deferralsByHost.set(host, (deferralsByHost.get(host) ?? 0) + 1)
  }
  /** Canary state per host, decided by the first link of the host. */
  /** Hosts whose canary was flagged this run. */
  const canaryTrials: Record<string, 'open' | 'flagged'> = {}
  /** Flag reasons per host for this run. */
  const canaryReasons = new Map<string, string>()
  /** Hosts whose canary succeeded this run: remaining links proceed. */
  const openHosts = new Set<string>()

  /** The config-backed policy for a host, enriched with the store state. */
  const policyFor = async (host: string) => {
    const state = (await store.getHostState(host)) ?? undefined
    const hasProfile = (await store.getProfile(host)) !== null
    const config = guard?.config.limits
    // The trial state honours the flag expiry: a flagged host is re-trialed
    // once the flag is older than the cooldown.
    const trialState = trialStateOf(state ?? null, now().getTime())
    return {
      policy: config
        ? hostPolicy(config, host, {
            hasProfile,
            trialState,
            loginGated: state?.loginGated ?? false,
          })
        : { strict: false, browser: false, skipped: false, reason: null },
      hasProfile,
      trialState,
    }
  }

  for (const link of batch) {
    let extractor = 'unknown'
    const host = hostOf(link.url)
    // Atomic claim: two concurrent runners race here, one wins, the loser
    // gets a typed STALE_STATE/ILLEGAL_TRANSITION and skips the link.
    const claim = await store.applyEvent(link.id, {
      type: 'EXTRACT_STARTED',
      at: now().toISOString(),
    })
    if (!claim.ok) {
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: true,
        skipped: true,
        error: 'already claimed',
      })
      continue
    }

    // The host policy: skip-list, manual override, canary flag, profile.
    const { policy, trialState } = await policyFor(host)

    // Skip-listed hosts are never fetched: the link is parked in the
    // terminal-ish `discarded` state with a clear reason. The lease is
    // released first (LEASE_EXPIRED), because TRIAGE is only legal from the
    // queue state.
    if (policy.skipped) {
      skippedHostCount += 1
      await store.applyEvent(link.id, {
        type: 'LEASE_EXPIRED',
        at: now().toISOString(),
      })
      await store.applyEvent(link.id, {
        type: 'TRIAGE',
        action: 'discard',
        at: now().toISOString(),
      })
      await store.setExpiry(link.id, null, SKIP_HOST_REASON, now())
      logger.info('{host} is skip-listed: {url} parked as discarded', {
        host,
        url: link.url,
      })
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: true,
        skipped: true,
        error: `skipped: ${SKIP_HOST_REASON}`,
      })
      continue
    }

    // Canary probing: the first link of a host is the canary. When an
    // earlier link of this host was flagged (rate limited, blocked, login
    // wall), the remaining links are deferred without a fetch. A canary
    // verdict is also read from the persisted trial state, so a restart
    // keeps honouring the flag. This check runs before the breaker check:
    // a flagged host defers with the flag name, not a generic breaker one.
    if (canaryTrials[host] === 'flagged' || trialState === 'flagged' || blockedHosts.has(host)) {
      deferredCount += 1
      bumpDeferral(host)
      const flagReason = canaryTrials[host] === 'flagged'
        ? `canary_flagged:${canaryReasons.get(host) ?? 'blocked'}`
        : `canary_flagged:${(await store.getHostState(host))?.trialReason ?? 'blocked'}`
      const decision = await deferOrError(
        store, link, 'extract', flagReason, 60 * 60 * 1000, maxAttempts, now(),
      )
      logger.info('{host} is flagged ({reason}): {url} deferred', {
        host,
        reason: flagReason,
        url: link.url,
      })
      if (decision.errored) {
        errorCount += 1
        outcomes.push({ linkId: link.id, url: link.url, ok: false, error: flagReason })
      } else {
        outcomes.push({
          linkId: link.id,
          url: link.url,
          ok: true,
          skipped: true,
          error: `deferred: ${flagReason}`,
        })
      }
      continue
    }

    try {
      let retriesThisLink = 0
      const result = guardActive
        ? await guardRun(guard as GuardDeps, host, () => options.extract(link.url), {
            onRetry: () => {
              retriesThisLink += 1
            },
          })
        : { kind: 'ok' as const, value: await options.extract(link.url), attempts: 1 }
      if (retriesThisLink > 0) {
        await store.addMetric({
          timestamp: now(),
          stage: STAGES.extract,
          key: 'retries',
          value: retriesThisLink,
          tags: { host },
        })
      }
      if (result.kind === 'defer') {
        deferredCount += 1
        bumpDeferral(host)
        retryAfter = Math.max(retryAfter, result.retryAfterMs)
        if (result.breakerOpen) {
          blockedHosts.add(host)
          // The canary failed: flag the host so its remaining links are
          // deferred (state `deferred`, reason names the flag) instead of
          // hammering it.
          const flagReason = result.reason.startsWith('blocked:')
            ? result.reason.slice('blocked:'.length)
            : result.reason.replace(/^breaker_open:/, '')
          await flagHost(store, host, now().getTime(), flagReason, flagReason === LOGIN_WALL_REASON)
          canaryTrials[host] = 'flagged'
          canaryReasons.set(host, flagReason)
          // An upstream Retry-After extends the host spacing until then.
          if (result.retryAfterMs > 0) {
            const state = await store.getHostState(host)
            if (state) {
              await store.saveHostState({
                ...state,
                rateLimitedUntil: Math.max(
                  state.rateLimitedUntil ?? 0,
                  now().getTime() + result.retryAfterMs,
                ),
              })
            }
          }
        }
        const decision = await deferOrError(
          store, link, 'extract', result.reason, result.retryAfterMs, maxAttempts, now(),
        )
        if (decision.errored) {
          errorCount += 1
          bump(errorsByExtractor, extractor)
          outcomes.push({ linkId: link.id, url: link.url, ok: false, error: result.reason })
        } else {
          outcomes.push({
            linkId: link.id,
            url: link.url,
            ok: true,
            skipped: true,
            error: `deferred: ${result.reason}`,
          })
        }
        continue
      }
      if (result.kind === 'error') {
        throw new Error(result.reason)
      }

      extractor = String(
        (result.value as { extractor?: string; route?: string }).extractor ??
          (result.value as { route?: string }).route ??
          'unknown',
      )
      const raw = result.value as {
        markdown?: string
        meta?: Record<string, unknown>
        needsBrowser?: boolean
        blocked?: boolean
        blockReason?: string
        gone?: number
        finalUrl?: string
        status?: number
        html?: string
      }

      // A 404/410 is only "gone" for an ordinary open host. A flagged host,
      // a host with a profile or a login-gated host answers anonymous
      // requests to private pages with a 404 too: that is a login wall.
      if (raw.gone !== undefined) {
        const { policy, hasProfile } = await policyFor(host)
        const trial = (await store.getHostState(host))?.trialState ?? 'unknown'
        const strict = policy.strict || policy.browser || hasProfile || trial === 'flagged'
        if (strict) {
          needsBrowserCount += 1
          bump(needsBrowserByExtractor, extractor)
          const wallReason = raw.gone === 404 ? 'private_404' : 'private_410'
          await recordLoginWall(store, link, host, now(), wallReason)
          await flagHost(store, host, now().getTime(), wallReason, true)
          canaryTrials[host] = 'flagged'
          canaryReasons.set(host, wallReason)
          logger.warn('private page on {host} (link {linkId}): run `linkinbox login {host}`', {
            host,
            linkId: link.id,
          })
          outcomes.push({
            linkId: link.id,
            url: link.url,
            ok: true,
            needsBrowser: true,
            error: `deferred: login_wall (http_${raw.gone})`,
          })
          okCount += 1
          continue
        }
        errorCount += 1
        bump(errorsByExtractor, extractor)
        await store.applyEvent(link.id, {
          type: 'EXTRACT_FAILED',
          error: `page is gone (HTTP ${raw.gone})`,
          retryable: false,
          at: now().toISOString(),
        })
        outcomes.push({
          linkId: link.id,
          url: link.url,
          ok: false,
          error: `page is gone (HTTP ${raw.gone})`,
        })
        continue
      }

      // A login wall or captcha: the host refused the session. Open its
      // breaker so the rest of the batch stops hammering it, flag the host
      // and defer.
      if (raw.blocked === true) {
        deferredCount += 1
        bumpDeferral(host)
        blockedHosts.add(host)
        const reason = `blocked:${raw.blockReason ?? LOGIN_WALL_REASON}`
        const waitMs = await openBreakerForHost(guard, host, now().getTime())
        retryAfter = Math.max(retryAfter, waitMs)
        await flagHost(store, host, now().getTime(), raw.blockReason ?? LOGIN_WALL_REASON, true)
        canaryTrials[host] = 'flagged'
        canaryReasons.set(host, raw.blockReason ?? LOGIN_WALL_REASON)
        const decision = await deferOrError(store, link, 'extract', reason, waitMs, maxAttempts, now())
        logger.warn('extraction blocked on {host} (link {linkId}): run `linkinbox login {host}`', {
          host,
          linkId: link.id,
        })
        if (decision.errored) {
          errorCount += 1
          bump(errorsByExtractor, extractor)
          outcomes.push({ linkId: link.id, url: link.url, ok: false, error: reason })
        } else {
          outcomes.push({
            linkId: link.id,
            url: link.url,
            ok: true,
            skipped: true,
            error: `deferred: ${reason}`,
          })
        }
        continue
      }

      const markdown = raw.markdown ?? ''

      // Login-wall detection on a page that returned content: the host
      // wants a session we do not have.
      const wall = detectLoginWall(raw, link.url, await policyFor(host))
      if (wall) {
        needsBrowserCount += 1
        bump(needsBrowserByExtractor, extractor)
        await recordLoginWall(store, link, host, now(), wall)
        // A login wall is a flag: the rest of this host's links wait.
        await flagHost(store, host, now().getTime(), wall, true)
        canaryTrials[host] = 'flagged'
        canaryReasons.set(host, wall)
        outcomes.push({
          linkId: link.id,
          url: link.url,
          ok: true,
          needsBrowser: true,
          error: `deferred: ${LOGIN_WALL_REASON}`,
        })
        okCount += 1
        continue
      }

      // The canary succeeded: the host is open, the remaining links of this
      // host proceed under the ordinary limits.
      await openHost(store, host, now().getTime())
      canaryTrials[host] = 'open'
      openHosts.add(host)

      const needsBrowser = raw.needsBrowser === true || markdown.trim() === ''
      if (needsBrowser) {
        needsBrowserCount += 1
        bump(needsBrowserByExtractor, extractor)
        await store.setExtractedContent(link.id, markdown, true, now())
        await store.applyEvent(link.id, {
          type: 'NEEDS_BROWSER',
          host,
          reason: wall ?? undefined,
          at: now().toISOString(),
        })
        logger.warn('extraction needs a browser for {url} (link {linkId}, extractor {extractor})', {
          url: link.url,
          linkId: link.id,
          extractor,
        })
        outcomes.push({
          linkId: link.id,
          url: link.url,
          ok: true,
          needsBrowser: true,
          chars: markdown.length,
        })
        okCount += 1
        continue
      }

      await store.setExtractedContent(link.id, markdown, false, now())
      bump(extractionsByExtractor, extractor)

      // The media stage: video links get their tiers run before the link
      // moves on to enrich. A media failure never fails the link: the report
      // is attached, the extracted content stays.
      let mediaRan = false
      if (options.media) {
        const meta = raw.meta ?? null
        if (isMediaLink(link.url, meta)) {
          const mediaRun = await runMediaStage(link, markdown, meta, options, logger)
          if (mediaRun) {
            mediaRan = true
            mediaCount += 1
            await store.setMediaReport(link.id, mediaRun.report, now())
            if (mediaRun.markdown.trim() !== '') {
              await store.setExtractedContent(
                link.id,
                `${markdown}\n\n${mediaRun.markdown}`,
                false,
                now(),
              )
            }
          }
        }
      }

      const done = await store.applyEvent(link.id, {
        type: 'EXTRACTED',
        chars: markdown.length,
        at: now().toISOString(),
      })
      if (!done.ok) {
        errorCount += 1
        bump(errorsByExtractor, extractor)
        outcomes.push({ linkId: link.id, url: link.url, ok: false, error: done.error.message })
        continue
      }
      okCount += 1
      logger.info('extracted {url} (link {linkId}, {chars} chars, extractor {extractor})', {
        url: link.url,
        linkId: link.id,
        chars: markdown.length,
        extractor,
      })
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: true,
        needsBrowser: false,
        chars: markdown.length,
        media: mediaRan,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      errorCount += 1
      bump(errorsByExtractor, extractor)
      const failed = await store.applyEvent(link.id, {
        type: 'EXTRACT_FAILED',
        error,
        at: now().toISOString(),
      })
      logger.error('extraction failed for {url}: {error}', { url: link.url, error })
      outcomes.push({
        linkId: link.id,
        url: link.url,
        ok: false,
        error: failed.ok ? error : failed.error.message,
      })
    }
  }

  await recordRunMetrics(store, {
    stage: STAGES.extract,
    run,
    startedAt,
    okCount,
    errorCount,
    inputCount: batch.length,
    now,
  })
  await store.addMetric({
    timestamp: now(),
    stage: STAGES.extract,
    key: 'needs_browser',
    value: needsBrowserCount,
  })
  if (deferredCount > 0) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'deferred',
      value: deferredCount,
    })
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'throttled',
      value: deferredCount,
    })
  }
  // Per-host resilience metrics: one row per host that appeared in the batch.
  for (const [host, count] of deferralsByHost) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'deferred',
      value: count,
      tags: { host },
    })
  }
  for (const host of blockedHosts) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'breaker_open',
      value: 1,
      tags: { host },
    })
  }
  for (const [name, count] of needsBrowserByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'needs_browser',
      value: count,
      tags: { extractor: name },
    })
  }
  for (const [name, count] of extractionsByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'extractions',
      value: count,
      tags: { extractor: name },
    })
  }
  for (const [name, count] of errorsByExtractor) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'errors',
      value: count,
      tags: { extractor: name },
    })
  }

  if (mediaCount > 0) {
    await store.addMetric({
      timestamp: now(),
      stage: STAGES.extract,
      key: 'media',
      value: mediaCount,
    })
  }

  const durationMs = now().getTime() - startedAt.getTime()
  await store.finishRun(run.id, {
    okCount,
    errorCount,
    durationMs,
  })
  logger.info('extract run {runId} finished: {okCount} ok, {errorCount} errors', {
    runId: run.id,
    okCount,
    errorCount,
  })

  return {
    stage: STAGES.extract,
    runId: run.id,
    inputCount: batch.length,
    okCount,
    errorCount,
    skippedCount: 0,
    durationMs,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    outcomes,
    warnings: [],
    needsBrowserCount,
    deferredCount,
    retryAfter,
    skippedHostCount,
    mediaCount,
    canaryTrials,
  }
}

/**
 * Run the media stage for one link. The stage never throws: a failure comes
 * back as a failed tier inside the report, so the link itself survives.
 *
 * A captured link skips the download: its content came from the user's own
 * session, so the pipeline does not fetch the media again.
 */
async function runMediaStage(
  link: Link,
  markdown: string,
  meta: Record<string, unknown> | null,
  options: ExtractOptions,
  logger: { error(message: string, properties?: Record<string, unknown>): void },
): Promise<MediaRun | null> {
  const media = options.media
  if (!media) return null
  try {
    const run = await media({
      url: link.url,
      content: markdown,
      meta,
      // A captured link keeps its own content: only the caption tier (which
      // fetches nothing) may run.
      ...(link.captured ? { tiers: ['caption' as const] } : {}),
    })
    if (!run || !Array.isArray(run.report?.tiers)) return null
    return run
  } catch (err) {
    logger.error('media stage failed for {url}: {error}', {
      url: link.url,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Open the host's circuit breaker after a hard block and return how long the
 * caller must wait before probing again.
 */
async function openBreakerForHost(
  guard: GuardDeps | undefined,
  host: string,
  now: number,
): Promise<number> {
  if (!guard) return 0
  const report = await breakerReport(
    {
      load: (key) => guard.getHostState(key),
      save: (state) => guard.saveHostState(state),
      clock: guard.clock,
      profile: guard.config.breaker,
    },
    host,
    'failure',
    { retryable: false, block: true, reason: LOGIN_WALL_REASON },
  )
  return report.state.openedUntil !== null ? Math.max(0, report.state.openedUntil - now) : 0
}

/**
 * Flag a host: the canary was rate limited or blocked. The flag lives in
 * the host_state row, so it survives restarts.
 */
async function flagHost(
  store: Store,
  host: string,
  now: number,
  reason: string,
  loginGated = false,
): Promise<void> {
  const state = (await store.getHostState(host)) ?? {
    ...emptyHostState(host),
    key: host,
  }
  await store.saveHostState(markFlagged(state, now, reason, { loginGated }))
}

/** Mark a host as open: the canary succeeded. */
async function openHost(store: Store, host: string, now: number): Promise<void> {
  const state = (await store.getHostState(host)) ?? {
    ...emptyHostState(host),
    key: host,
  }
  await store.saveHostState(markOpen(state, now))
}

/**
 * Park a link behind a login wall: the link moves to `needs_browser` with
 * the reason `login_wall` in its state data.
 */
async function recordLoginWall(
  store: Store,
  link: Link,
  host: string,
  now: Date,
  reason: string,
): Promise<void> {
  await store.setExtractedContent(link.id, '', true, now)
  const outcome = await store.applyEvent(link.id, {
    type: 'NEEDS_BROWSER',
    host,
    reason,
    at: now.toISOString(),
  })
  if (!outcome.ok) {
    // The link is no longer in a state that accepts the event: nothing to
    // park.
    return
  }
  // The expiry reason carries the wall reason for the login command.
  await store.setExpiry(link.id, null, reason, now)
}

/**
 * Decide whether the extracted page is a login wall. Returns the reason or
 * null when the page is real content.
 */
function detectLoginWall(
  raw: { markdown?: string; html?: string; finalUrl?: string; status?: number },
  url: string,
  policy: { hasProfile: boolean },
): string | null {
  // The password-field rule needs the html; the content rules need markdown.
  const present = [raw.html, raw.markdown].filter((b): b is string => typeof b === 'string')
  const bodies = present.length > 0 ? present : ['']
  const isWall = bodies.some((body) =>
    isLoginWall({
      url: raw.finalUrl ?? url,
      body,
      status: raw.status,
      hasProfile: policy.hasProfile,
    }),
  )
  if (isWall) {
    return LOGIN_WALL_REASON
  }
  return null
}

/** Attempts burned so far, read from the link's FSM history. */
async function preAttempts(store: Store, linkId: number): Promise<number> {
  return attemptsOf(store, linkId)
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}
