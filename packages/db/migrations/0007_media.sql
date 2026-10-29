
-- Media stage: the per-tier report per link, and the per-day budget
-- counters so the media daily cap survives restarts.
ALTER TABLE links ADD COLUMN media_report TEXT;
CREATE TABLE IF NOT EXISTS media_budget (
  day TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  by_tier TEXT NOT NULL DEFAULT '{}'
);
