/// <reference path="./shims.d.ts" />
// Shared raw-SQL read layer against the real atento schema (stand-in for the drizzle store).
import { Database } from "@cutils/sqlite/elf";
import { dbPath } from "./config.ts";

let cached: Database | null = null;
export function getDb(): Database {
  if (cached === null) cached = Database.open(dbPath(), { readonly: true });
  return cached;
}

// @chttp/val InferOutput<VObject> is { [k: string]: unknown }, so typed rows are narrowed by hand.
export function str(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}
export function num(x: unknown): number | null {
  return typeof x === "number" ? x : null;
}
export class LinkRowT {
  id = 0; url = ""; title: string | null = null; status = ""; category: string | null = null;
  priority: string | null = null; action: string | null = null; expires_at: number | null = null;
  expiry_reason: string | null = null; read_minutes: number | null = null; needs_browser = 0;
}
export function toLink(raw: unknown): LinkRowT {
  const o = raw as { [k: string]: unknown };
  const r = new LinkRowT();
  r.id = num(o["id"]) ?? 0; r.url = str(o["url"]) ?? ""; r.title = str(o["title"]);
  r.status = str(o["status"]) ?? ""; r.category = str(o["category"]); r.priority = str(o["priority"]);
  r.action = str(o["action"]); r.expires_at = num(o["expires_at"]); r.expiry_reason = str(o["expiry_reason"]);
  r.read_minutes = num(o["read_minutes"]); r.needs_browser = num(o["needs_browser"]) ?? 0;
  return r;
}
export function counts(): { k: string; n: number }[] {
  const st = getDb().prepareRaw("SELECT state AS k, COUNT(*) AS n FROM links GROUP BY state");
  const out: { k: string; n: number }[] = [];
  for (const raw of st.allRaw([])) {
    const o = raw as { [k: string]: unknown };
    out.push({ k: str(o["k"]) ?? "", n: num(o["n"]) ?? 0 });
  }
  st.finalize();
  return out;
}


export function jstr(s: string | null): string {
  return s === null ? "null" : JSON.stringify(s);
}
export function jnum(n: number | null): string {
  return n === null ? "null" : String(n);
}
export function isoOrNull(ms: number | null): string {
  return ms === null ? "null" : JSON.stringify(new Date(ms).toISOString());
}
export function linkJson(r: LinkRowT): string {
  return (
    '{"id":' + r.id +
    ',"url":' + JSON.stringify(r.url) +
    ',"title":' + jstr(r.title) +
    ',"status":' + JSON.stringify(r.status) +
    ',"category":' + jstr(r.category) +
    ',"priority":' + jstr(r.priority) +
    ',"action":' + jstr(r.action) +
    ',"expiresAt":' + isoOrNull(r.expires_at) +
    ',"expiryReason":' + jstr(r.expiry_reason) +
    ',"readMinutes":' + jnum(r.read_minutes) +
    ',"needsBrowser":' + (r.needs_browser === 1 ? "true" : "false") + "}"
  );
}

export const COLS =
  "id, url, title, status, category, priority, action, expires_at, expiry_reason, read_minutes, needs_browser, state";


export function listJson(status: string | null, limit: number): string {
  const parts: string[] = [];
  if (status === null) {
    const st = getDb().prepareRaw("SELECT " + COLS + " FROM links ORDER BY created_at DESC, id DESC LIMIT ?");
    for (const r of st.allRaw([limit])) parts.push(linkJson(toLink(r)));
    st.finalize();
  } else {
    const st = getDb().prepareRaw("SELECT " + COLS + " FROM links WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?");
    for (const r of st.allRaw([status, limit])) parts.push(linkJson(toLink(r)));
    st.finalize();
  }
  return "[" + parts.join(",") + "]";
}

export function overviewJson(): string {
  const rows = counts();
  const states = ["created", "extracting", "extracted", "needs_browser", "deferred", "enriching", "inbox", "scheduled", "archived", "discarded", "errored", "deleted"];
  const parts: string[] = [];
  let total = 0;
  for (const s of states) {
    let n = 0;
    for (const r of rows) if (r.k === s) n = r.n;
    total += n;
    parts.push(JSON.stringify(s) + ":" + n);
  }
  return '{"total":' + total + ',"byState":{' + parts.join(",") + "}}";
}

// Full `show` record, same key order as the Node CLI. JSON text columns are embedded as-is.
export const SHOW_COLS =
  "id, url, title, source, added_at, tags, note, status, state, state_data, category, priority, action, confidence, read_minutes, expires_at, expiry_reason, needs_browser, extracted_at, enrichment, media_report, extracted_content";

function jraw(x: unknown): string {
  return typeof x === "string" ? x : "null";
}
export function showJson(raw: unknown): string {
  const o = raw as { [k: string]: unknown };
  return (
    '{"id":' + jnum(num(o["id"])) +
    ',"url":' + jstr(str(o["url"])) +
    ',"title":' + jstr(str(o["title"])) +
    ',"source":' + jstr(str(o["source"])) +
    ',"addedAt":' + isoOrNull(num(o["added_at"])) +
    ',"tags":' + jraw(o["tags"]) +
    ',"note":' + jstr(str(o["note"])) +
    ',"status":' + jstr(str(o["status"])) +
    ',"state":' + jstr(str(o["state"])) +
    ',"stateData":' + jraw(o["state_data"]) +
    ',"category":' + jstr(str(o["category"])) +
    ',"priority":' + jstr(str(o["priority"])) +
    ',"action":' + jstr(str(o["action"])) +
    ',"confidence":' + jnum(num(o["confidence"])) +
    ',"readMinutes":' + jnum(num(o["read_minutes"])) +
    ',"expiresAt":' + isoOrNull(num(o["expires_at"])) +
    ',"expiryReason":' + jstr(str(o["expiry_reason"])) +
    ',"needsBrowser":' + (num(o["needs_browser"]) === 1 ? "true" : "false") +
    ',"extractedAt":' + isoOrNull(num(o["extracted_at"])) +
    ',"enrichment":' + jraw(o["enrichment"]) +
    ',"mediaReport":' + jraw(o["media_report"]) +
    ',"extracted_content":' + jstr(str(o["extracted_content"])) + "}"
  );
}
