
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
