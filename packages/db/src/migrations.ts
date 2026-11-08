import type { Database } from 'better-sqlite3'

/**
 * Migration runner. Each migration is applied in order and recorded in the
 * `meta` table under `migration:<name>` so `migrate()` is idempotent.
 */
export interface Migration {
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    name: '0001_initial',
    sql: `
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
`,
  },
  {
    name: '0002_fsm',
    sql: `
ALTER TABLE links ADD COLUMN state TEXT NOT NULL DEFAULT 'created';
ALTER TABLE links ADD COLUMN state_data TEXT;

CREATE TABLE IF NOT EXISTS link_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS link_events_link_idx ON link_events (link_id);
CREATE INDEX IF NOT EXISTS link_events_at_idx ON link_events (at);

-- Backfill the FSM discriminant from the legacy status column.
UPDATE links SET state = status;

-- History rows are
-- synthesized so the log is complete for pre-FSM links.
INSERT INTO link_events (link_id, from_state, to_state, event, data, at)
SELECT id, 'created', CASE status
    WHEN 'inbox' THEN 'inbox'
    WHEN 'scheduled' THEN 'scheduled'
    WHEN 'archived' THEN 'archived'
    WHEN 'discarded' THEN 'discarded'
    ELSE 'inbox'
  END,
  CASE status
    WHEN 'archived' THEN 'EXPIRE'
    WHEN 'discarded' THEN 'TRIAGE'
    ELSE 'ENRICHED'
  END,
  NULL,
  updated_at
FROM links;

UPDATE links SET state_data = json_object(
  'enriched', CASE WHEN enrichment IS NOT NULL OR category IS NOT NULL
    THEN json('true') ELSE json('false') END
) WHERE state = 'inbox';

UPDATE links SET state_data = json_object('scheduledFor', NULL) WHERE state = 'scheduled';

UPDATE links SET state_data = json_object(
  'archivedAt', datetime(updated_at / 1000, 'unixepoch'),
  'reason', 'manual'
) WHERE state = 'archived';

UPDATE links SET state_data = json_object(
  'discardedAt', datetime(updated_at / 1000, 'unixepoch')
) WHERE state = 'discarded';

CREATE INDEX IF NOT EXISTS links_state_idx ON links (state);

-- Guard the discriminant: only known states can be stored. state_data is
-- validated by the zod union on read.
CREATE TRIGGER IF NOT EXISTS links_state_check
BEFORE INSERT ON links
WHEN NEW.state NOT IN (
  'created', 'extracting', 'extracted', 'needs_browser', 'deferred',
  'enriching', 'inbox', 'scheduled', 'archived', 'discarded', 'errored', 'deleted'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid links.state');
END;
CREATE TRIGGER IF NOT EXISTS links_state_check_upd
BEFORE UPDATE OF state ON links
WHEN NEW.state NOT IN (
  'created', 'extracting', 'extracted', 'needs_browser', 'deferred',
  'enriching', 'inbox', 'scheduled', 'archived', 'discarded', 'errored', 'deleted'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid links.state');
END;
`,
  },
  {
    name: '0003_host_state',
    sql: `
-- Per-host limiter and circuit breaker state. Shared by every process that
-- touches the same database: the CLI, the server and the MCP server.
CREATE TABLE IF NOT EXISTS host_state (
  key TEXT PRIMARY KEY,
  last_request_at INTEGER,
  window_start INTEGER,
  window_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker_state TEXT NOT NULL DEFAULT 'closed',
  opened_until INTEGER,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
`,
  },
  {
    name: '0004_canary_trial',
    sql: `
-- Canary probing: per-host trial outcome (unknown/open/flagged), why the
-- host was flagged, when the trial ran, whether the host is login gated,
-- and the upstream pacing signal (Retry-After / X-RateLimit-*).
ALTER TABLE host_state ADD COLUMN trial_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE host_state ADD COLUMN trial_reason TEXT;
ALTER TABLE host_state ADD COLUMN trial_at INTEGER;
ALTER TABLE host_state ADD COLUMN login_gated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE host_state ADD COLUMN rate_limited_until INTEGER;
`,
  },
  {
    name: '0005_capture',
    sql: `
-- Client-side capture ingest: content already extracted in the user's own
-- logged-in session and POSTed to the capture endpoint. The marker skips the
-- headless extract step in the pipeline.
ALTER TABLE links ADD COLUMN captured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN captured_at INTEGER;
`,
  },
  {
    name: '0006_human_pacing',
    sql: `
-- Human pacing for strict hosts: pages served since the last long break and
-- the drawn pages-per-cycle, so the break cadence survives restarts.
ALTER TABLE host_state ADD COLUMN pages_since_break INTEGER;
ALTER TABLE host_state ADD COLUMN break_every INTEGER;
`,
  },
  {
    name: '0007_media',
    sql: `
-- Media stage: the per-tier report per link, and the per-day budget
-- counters so the media daily cap survives restarts.
ALTER TABLE links ADD COLUMN media_report TEXT;
CREATE TABLE IF NOT EXISTS media_budget (
  day TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  by_tier TEXT NOT NULL DEFAULT '{}'
);
`,
  },
  {
    name: '0008_run_journal',
    sql: `
-- Durable execution: the runs table doubles as the run journal. A row with
-- status 'running' is the single-writer lock for its stage; pid and
-- heartbeat_at let the next start detect a crashed run and reclaim its
-- leases immediately instead of waiting out the lease timeout.
ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE runs ADD COLUMN pid INTEGER;
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
`,
  },
  {
    name: '0009_ingest_jobs',
    sql: `
-- Durable ingest: bulk input is spooled to disk and committed in chunks.
-- cursor counts the spooled input lines already committed, so a crash
-- resumes exactly there; run_id ties the job to its journal run.
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  spool_path TEXT,
  run_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx ON ingest_jobs (status);
CREATE INDEX IF NOT EXISTS ingest_jobs_created_idx ON ingest_jobs (created_at);
`,
  },
  {
    name: '0010_links_fts',
    sql: `
-- FTS5 full-text search over the searchable columns of the link row:
-- title, url, note, tags, and the enrichment summary. There is no summary
-- column on links, so 'summary' is derived: the enrichment blob's
-- why_it_matters text, extracted with json_extract (guarded by json_valid
-- so a hand-edited row can never break the index).
--
-- This is a plain FTS5 table holding its own copy of the indexed text, not
-- an external-content table: triggers then maintain it with ordinary
-- DELETE + INSERT, with no 'delete' command tuples or rebuild edge cases.
CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
  title,
  url,
  note,
  tags,
  summary,
  tokenize = 'unicode61'
);

-- Triggers, not store-level sync: the links table has many write paths
-- (upsert, patchLink, applyEvent with its patch + deleted-state purge,
-- setEnrichment, updateTitle) and triggers fire on the table itself, so a
-- future write path cannot forget to update the index. UPDATE OF limits
-- reindexing to the columns that feed the index; writes that touch only
-- state_data, media_report or timestamps skip it.
CREATE TRIGGER IF NOT EXISTS links_fts_ai AFTER INSERT ON links BEGIN
  INSERT INTO links_fts (rowid, title, url, note, tags, summary)
  VALUES (
    new.id,
    new.title,
    new.url,
    new.note,
    new.tags,
    CASE WHEN json_valid(new.enrichment)
      THEN json_extract(new.enrichment, '$.why_it_matters')
    END
  );
END;

CREATE TRIGGER IF NOT EXISTS links_fts_ad AFTER DELETE ON links BEGIN
  DELETE FROM links_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS links_fts_au
AFTER UPDATE OF title, url, note, tags, enrichment ON links BEGIN
  DELETE FROM links_fts WHERE rowid = old.id;
  INSERT INTO links_fts (rowid, title, url, note, tags, summary)
  VALUES (
    new.id,
    new.title,
    new.url,
    new.note,
    new.tags,
    CASE WHEN json_valid(new.enrichment)
      THEN json_extract(new.enrichment, '$.why_it_matters')
    END
  );
END;

-- Backfill every existing row so the index is complete the moment the
-- migration lands. The DELETE first makes the backfill self-healing: if a
-- pre-transactional crash ever left fts rows behind without the meta row,
-- the re-run rebuilds the index instead of dying on duplicate rowids.
DELETE FROM links_fts;
INSERT INTO links_fts (rowid, title, url, note, tags, summary)
SELECT
  id,
  title,
  url,
  note,
  tags,
  CASE WHEN json_valid(enrichment)
    THEN json_extract(enrichment, '$.why_it_matters')
  END
FROM links;
`,
  },
]

const META_TABLE = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`

/**
 * Apply pending migrations. Safe to call on every open. The `migrations`
 * parameter exists for tests; production callers always use MIGRATIONS.
 */
export function runMigrations(sqlite: Database, migrations: Migration[] = MIGRATIONS): string[] {
  sqlite.exec(META_TABLE)
  const applied: string[] = []
  const done = new Set<string>()
  const rows = sqlite.prepare(`SELECT key FROM meta WHERE key LIKE 'migration:%'`).all() as Array<{
    key: string
  }>
  for (const row of rows) done.add(row.key.slice('migration:'.length))

  for (const migration of migrations) {
    if (done.has(migration.name)) continue
    // One transaction per migration: the DDL and its meta row commit
    // together or not at all. Without this a crash mid-migration (e.g.
    // during 0010's backfill) would leave objects behind with no meta row,
    // and the re-run would fail forever on duplicate rowids.
    const apply = sqlite.transaction(() => {
      sqlite.exec(migration.sql)
      sqlite
        .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
        .run(`migration:${migration.name}`, new Date().toISOString())
    })
    apply()
    applied.push(migration.name)
  }
  return applied
}
