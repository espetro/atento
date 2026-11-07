
-- Durable execution: the runs table doubles as the run journal. A row with
-- status 'running' is the single-writer lock for its stage; pid and
-- heartbeat_at let the next start detect a crashed run and reclaim its
-- leases immediately instead of waiting out the lease timeout.
ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE runs ADD COLUMN pid INTEGER;
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
