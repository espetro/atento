
-- Client-side capture ingest: content already extracted in the user's own
-- logged-in session and POSTed to the capture endpoint. The marker skips the
-- headless extract step in the pipeline.
ALTER TABLE links ADD COLUMN captured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN captured_at INTEGER;
