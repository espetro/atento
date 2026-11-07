/// <reference path="./shims.d.ts" />
/**
 * S1 spike — @cutils/sqlite-backed Store adapter (SUBSET).
 *
 * Implements the link-read/write + meta slice of the `Store` contract from
 * packages/core/src/store.ts, on raw SQL over @cutils/sqlite instead of
 * drizzle/better-sqlite3. Deliberately NOT implemented (documented gaps):
 * applyEvent/getHistory/linkEventCursor/listChangedLinks/listLinkEvents/
 * countByState/listByStates/getState/setStateData plus the reclaim family,
 * run journal, ingest jobs, metrics, profiles and host state — those are
 * the remaining port.
 */
import { Database } from "@cutils/sqlite";
import { createHash } from "node:crypto";
import type {
  Link,
  LinkInput,
  Status,
  Enrichment,
} from "../../packages/core/src/types.js";
import type { MediaReport } from "../../packages/core/src/media.js";
import type { LinkFilter } from "../../packages/core/src/store.js";

const SCHEMA_VERSION = "9";

const DDL = `
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
  captured INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER,
  state TEXT NOT NULL DEFAULT 'created',
  state_data TEXT,
  media_report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS links_url_hash_idx ON links (url_hash);
CREATE INDEX IF NOT EXISTS links_status_idx ON links (status);
CREATE INDEX IF NOT EXISTS links_expires_at_idx ON links (expires_at);
CREATE INDEX IF NOT EXISTS links_category_idx ON links (category);
CREATE INDEX IF NOT EXISTS links_state_idx ON links (state);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Row shape as returned by SELECT * (snake_case columns).
interface LinkRow {
  id: number;
  url_hash: string;
  url: string;
  title: string | null;
  source: string;
  added_at: number | null;
  note: string | null;
  tags: string | null;
  extracted_content: string | null;
  extracted_at: number | null;
  enrichment: string | null;
  expires_at: number | null;
  expiry_reason: string | null;
  status: string;
  read_minutes: number | null;
  category: string | null;
  priority: string | null;
  action: string | null;
  confidence: number | null;
  needs_browser: number;
  captured: number;
  captured_at: number | null;
  state: string;
  state_data: string | null;
  media_report: string | null;
  created_at: number;
  updated_at: number;
}

function ms(d: Date | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  return d.getTime();
}

function dt(v: number | null): Date | null {
  if (v === null) return null;
  return new Date(v);
}

function jstr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

function jparse<T>(v: string | null): T | null {
  if (v === null) return null;
  return JSON.parse(v) as T;
}

function urlHashOf(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export class CutilsSqliteStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(path: string): CutilsSqliteStore {
    const db = Database.open(path, { fileMustExist: false });
    const store = new CutilsSqliteStore(db);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = FULL");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    return store;
  }

  static openInMemory(): CutilsSqliteStore {
    return CutilsSqliteStore.open(":memory:");
  }

  async migrate(): Promise<void> {
    this.db.exec(DDL);
    if ((await this.getMeta("schema_version")) === null) {
      this.setMeta("schema_version", SCHEMA_VERSION);
    }
  }

  async schemaVersion(): Promise<string> {
    const v = await this.getMeta("schema_version");
    return v === null ? "0" : v;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async getMeta(key: string): Promise<string | null> {
    const stmt = this.db.prepareRaw("SELECT value FROM meta WHERE key = ?");
    const row = stmt.getOrNull([key]) as { value: string } | null;
    stmt.finalize();
    return row === null ? null : row.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const stmt = this.db.prepareRaw(
      "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    stmt.run([key, value]);
    stmt.finalize();
  }

  private fromRow(row: LinkRow): Link {
    return {
      id: row.id,
      urlHash: row.url_hash,
      url: row.url,
      title: row.title,
      source: row.source,
      addedAt: dt(row.added_at),
      note: row.note,
      tags: jparse<string[]>(row.tags),
      extractedContent: row.extracted_content,
      extractedAt: dt(row.extracted_at),
      enrichment: jparse<Enrichment>(row.enrichment),
      expiresAt: dt(row.expires_at),
      expiryReason: row.expiry_reason,
      status: row.status as Status,
      category: row.category,
      priority: row.priority as Enrichment["priority"] | null,
      action: row.action as Enrichment["action"] | null,
      confidence: row.confidence,
      readMinutes: row.read_minutes,
      needsBrowser: row.needs_browser === 1,
      captured: row.captured === 1,
      capturedAt: dt(row.captured_at),
      mediaReport: jparse<MediaReport>(row.media_report),
      state: row.state,
      stateData: jparse<Record<string, unknown>>(row.state_data),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async upsertLink(input: LinkInput): Promise<Link> {
    const now = new Date();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const enrichment = input.enrichment ?? null;
    const status: Status = input.status ?? "inbox";

    // Tombstone rule (mirrors SqliteStore): a url whose link was deleted is
    // never resurrected by re-import.
    const tomb = this.db
      .prepareRaw(
        "SELECT id FROM links WHERE url_hash = ? AND state = 'deleted' LIMIT 1",
      )
      .getOrNull([input.urlHash]);
    if (tomb !== null) {
      const t = tomb as { id: number };
      return this.getLink(t.id) as Promise<Link>;
    }

    const existing = this.db
      .prepareRaw("SELECT id FROM links WHERE url_hash = ?")
      .getOrNull([input.urlHash]) as { id: number } | null;

    if (existing !== null) {
      // Idempotent re-import: only url/title/source/added_at/note/tags move.
      this.db
        .prepareRaw(
          "UPDATE links SET url = ?, title = ?, source = ?, added_at = ?, " +
            "note = ?, tags = ?, updated_at = ? WHERE id = ?",
        )
        .run([
          input.url,
          input.title ?? null,
          input.source,
          ms(input.addedAt),
          input.note ?? null,
          jstr(input.tags ?? null),
          updatedAt.getTime(),
          existing.id,
        ]);
      const row = this.db
        .prepareRaw("SELECT * FROM links WHERE id = ?")
        .getOrNull([existing.id]) as LinkRow | null;
      return this.fromRow(row as LinkRow);
    }

    const state = input.state ?? "created";
    const stateData = input.stateData ?? null;
    const res = this.db
      .prepareRaw(
        "INSERT INTO links (url_hash, url, title, source, added_at, note, tags, " +
          "extracted_content, extracted_at, enrichment, expires_at, expiry_reason, " +
          "status, read_minutes, category, priority, action, confidence, " +
          "needs_browser, captured, captured_at, state, state_data, media_report, " +
          "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run([
        input.urlHash,
        input.url,
        input.title ?? null,
        input.source,
        ms(input.addedAt),
        input.note ?? null,
        jstr(input.tags ?? null),
        input.extractedContent ?? null,
        ms(input.extractedAt),
        jstr(enrichment),
        ms(input.expiresAt),
        input.expiryReason ?? null,
        status,
        enrichment === null ? null : enrichment.read_minutes,
        enrichment === null ? null : enrichment.category,
        enrichment === null ? null : enrichment.priority,
        enrichment === null ? null : enrichment.action,
        enrichment === null ? null : enrichment.confidence,
        (input.needsBrowser ?? false) ? 1 : 0,
        (input.captured ?? false) ? 1 : 0,
        ms(input.capturedAt),
        state,
        jstr(stateData),
        jstr(input.mediaReport ?? null),
        createdAt.getTime(),
        updatedAt.getTime(),
      ]);
    const id = Number(res.lastInsertRowid);
    const row = this.db
      .prepareRaw("SELECT * FROM links WHERE id = ?")
      .getOrNull([id]) as LinkRow | null;
    return this.fromRow(row as LinkRow);
  }

  async getLink(id: number): Promise<Link | null> {
    const row = this.db
      .prepareRaw("SELECT * FROM links WHERE id = ?")
      .getOrNull([id]) as LinkRow | null;
    return row === null ? null : this.fromRow(row);
  }

  async getLinkByUrlHash(urlHash: string): Promise<Link | null> {
    const row = this.db
      .prepareRaw("SELECT * FROM links WHERE url_hash = ?")
      .getOrNull([urlHash]) as LinkRow | null;
    return row === null ? null : this.fromRow(row);
  }

  async listLinks(filter?: LinkFilter): Promise<Link[]> {
    let sql = "SELECT * FROM links";
    const params: (string | number)[] = [];
    const conds: string[] = [];
    if (filter !== undefined && filter.status !== undefined) {
      conds.push("status = ?");
      params.push(filter.status);
    }
    if (filter !== undefined && filter.category !== undefined) {
      conds.push("category = ?");
      params.push(filter.category);
    }
    if (conds.length > 0) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY created_at DESC, id DESC";
    if (filter !== undefined && filter.limit !== undefined) {
      sql += " LIMIT " + String(filter.limit);
      if (filter.offset !== undefined) sql += " OFFSET " + String(filter.offset);
    }
    const rows = this.db.prepareRaw(sql).all(params) as LinkRow[];
    const out: Link[] = [];
    for (let i = 0; i < rows.length; i++) out.push(this.fromRow(rows[i]));
    return out;
  }

  async countLinks(filter?: LinkFilter): Promise<number> {
    let sql = "SELECT COUNT(*) AS n FROM links";
    const params: (string | number)[] = [];
    const conds: string[] = [];
    if (filter !== undefined && filter.status !== undefined) {
      conds.push("status = ?");
      params.push(filter.status);
    }
    if (conds.length > 0) sql += " WHERE " + conds.join(" AND ");
    const row = this.db.prepareRaw(sql).getOrNull(params) as { n: number } | null;
    return row === null ? 0 : row.n;
  }
}
