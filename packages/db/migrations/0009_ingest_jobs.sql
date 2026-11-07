
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
