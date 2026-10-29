import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * Links table. `urlHash` is the dedupe key (sha256 of the normalized URL)
 * and carries a unique index so upserts are idempotent.
 */
export const links = sqliteTable(
  'links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    urlHash: text('url_hash').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    source: text('source').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }),
    note: text('note'),
    tags: text('tags', { mode: 'json' }).$type<string[] | null>(),
    extractedContent: text('extracted_content'),
    extractedAt: integer('extracted_at', { mode: 'timestamp_ms' }),
    enrichment: text('enrichment', { mode: 'json' }).$type<unknown>(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    expiryReason: text('expiry_reason'),
    status: text('status').notNull().default('inbox'),
    readMinutes: integer('read_minutes'),
    category: text('category'),
    priority: text('priority'),
    action: text('action'),
    confidence: real('confidence'),
    needsBrowser: integer('needs_browser', { mode: 'boolean' }).notNull().default(false),
    /** Client-side capture marker (0005_capture). */
    captured: integer('captured', { mode: 'boolean' }).notNull().default(false),
    capturedAt: integer('captured_at', { mode: 'timestamp_ms' }),
    /** FSM discriminant. */
    state: text('state').notNull().default('created'),
    /** FSM variant payload (json). */
    stateData: text('state_data', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('links_url_hash_idx').on(t.urlHash),
    index('links_status_idx').on(t.status),
    index('links_expires_at_idx').on(t.expiresAt),
    index('links_category_idx').on(t.category),
    index('links_state_idx').on(t.state),
  ],
)

/** Append-only transition log: one row per applied event. */
export const linkEvents = sqliteTable(
  'link_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    linkId: integer('link_id').notNull(),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    event: text('event').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('link_events_link_idx').on(t.linkId),
    index('link_events_at_idx').on(t.at),
  ],
)

/** One row per pipeline stage execution. */
export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    stage: text('stage').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    inputCount: integer('input_count').notNull().default(0),
    okCount: integer('ok_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'),
  },
  (t) => [index('runs_stage_idx').on(t.stage), index('runs_started_at_idx').on(t.startedAt)],
)

/** Numeric metric samples, tagged. */
export const metrics = sqliteTable(
  'metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    stage: text('stage').notNull(),
    key: text('key').notNull(),
    value: real('value').notNull(),
    tags: text('tags', { mode: 'json' }).$type<Record<string, string> | null>(),
  },
  (t) => [
    index('metrics_stage_idx').on(t.stage),
    index('metrics_timestamp_idx').on(t.timestamp),
    index('metrics_key_idx').on(t.key),
  ],
)

/** agent-browser profile paths per host, for the `login` command bookkeeping. */
export const profiles = sqliteTable(
  'profiles',
  {
    host: text('host').primaryKey(),
    path: text('path').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
)

/** Per-host limiter + breaker state, shared across CLI runs, server and MCP. */
export const hostState = sqliteTable('host_state', {
  key: text('key').primaryKey(),
  lastRequestAt: integer('last_request_at'),
  windowStart: integer('window_start'),
  windowCount: integer('window_count').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  breakerState: text('breaker_state').notNull().default('closed'),
  openedUntil: integer('opened_until'),
  cooldownLevel: integer('cooldown_level').notNull().default(0),
  lastError: text('last_error'),
  trialState: text('trial_state').notNull().default('unknown'),
  trialReason: text('trial_reason'),
  trialAt: integer('trial_at'),
  loginGated: integer('login_gated', { mode: 'boolean' }).notNull().default(false),
  rateLimitedUntil: integer('rate_limited_until'),
})

/** Schema version and config snapshots. */
export const meta = sqliteTable(
  'meta',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
  },
)

export const schema = { links, linkEvents, runs, metrics, profiles, meta }

export type LinkRow = typeof links.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type MetricRow = typeof metrics.$inferSelect
export type ProfileRow = typeof profiles.$inferSelect
export type MetaRow = typeof meta.$inferSelect
export type LinkEventRow = typeof linkEvents.$inferSelect

export const SCHEMA_VERSION = '4'
