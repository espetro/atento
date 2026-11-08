
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
