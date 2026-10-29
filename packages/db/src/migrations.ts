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
    name: '0005_human_pacing',
    sql: `
-- Human pacing for strict hosts: pages served since the last long break and
-- the drawn pages-per-cycle, so the break cadence survives restarts.
ALTER TABLE host_state ADD COLUMN pages_since_break INTEGER;
ALTER TABLE host_state ADD COLUMN break_every INTEGER;
`,
  },
]

const META_TABLE = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`

/** Apply pending migrations. Safe to call on every open. */
export function runMigrations(sqlite: Database): string[] {
  sqlite.exec(META_TABLE)
  const applied: string[] = []
  const done = new Set<string>()
  const rows = sqlite.prepare(`SELECT key FROM meta WHERE key LIKE 'migration:%'`).all() as Array<{
    key: string
  }>
  for (const row of rows) done.add(row.key.slice('migration:'.length))

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue
    sqlite.exec(migration.sql)
    sqlite
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
      .run(`migration:${migration.name}`, new Date().toISOString())
    applied.push(migration.name)
  }
  return applied
}
