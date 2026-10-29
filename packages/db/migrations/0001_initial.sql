
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
