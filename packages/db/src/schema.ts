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
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('links_url_hash_idx').on(t.urlHash),
    index('links_status_idx').on(t.status),
    index('links_expires_at_idx').on(t.expiresAt),
    index('links_category_idx').on(t.category),
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

/** Schema version and config snapshots. */
export const meta = sqliteTable(
  'meta',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
  },
)

export const schema = { links, runs, metrics, profiles, meta }

export type LinkRow = typeof links.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type MetricRow = typeof metrics.$inferSelect
export type ProfileRow = typeof profiles.$inferSelect
export type MetaRow = typeof meta.$inferSelect

export const SCHEMA_VERSION = '1'

/** Raw DDL, applied by `SqliteStore.migrate()`. Kept as plain SQL so the
 * migration path does not depend on a driver-specific query builder. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL,
  added_at INTEGER,
  note TEXT,
  tags TEXT,
  extracted_content TEXT,
  extracted_at INTEGER,
  enrichment TEXT,
  expires_at INTEGER,
  expiry_reason TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  read_minutes INTEGER,
  category TEXT,
  priority TEXT,
  action TEXT,
  confidence REAL,
  needs_browser INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS links_url_hash_idx ON links (url_hash);
CREATE INDEX IF NOT EXISTS links_status_idx ON links (status);
CREATE INDEX IF NOT EXISTS links_expires_at_idx ON links (expires_at);
CREATE INDEX IF NOT EXISTS links_category_idx ON links (category);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_count INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS runs_stage_idx ON runs (stage);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  stage TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  tags TEXT
);
CREATE INDEX IF NOT EXISTS metrics_stage_idx ON metrics (stage);
CREATE INDEX IF NOT EXISTS metrics_timestamp_idx ON metrics (timestamp);
CREATE INDEX IF NOT EXISTS metrics_key_idx ON metrics (key);

CREATE TABLE IF NOT EXISTS profiles (
  host TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
