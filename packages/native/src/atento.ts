/// <reference path="./shims.d.ts" />
// Native read layer over the real atento schema: raw SQL ports of the pure parts of
// @atento/core (projection, park reasons, collections, overview, pipeline rows) and of
// SqliteStore.listLinks. Every function returns JSON text so Node and native outputs can be
// compared byte for byte.
import { getDb, str, num, jstr, jnum, isoOrNull } from "./lib.ts";

type Raw = { [k: string]: unknown };

export const STATES = [
  "created", "extracting", "extracted", "needs_browser", "deferred", "enriching",
  "inbox", "scheduled", "archived", "discarded", "errored", "deleted",
];
export const PARK_REASONS = [
  "login_wall", "bot_block", "js_shell", "http_error", "timeout", "review_only", "skipped", "unknown",
];
export const COLLECTIONS = ["enriched", "pending", "needs_login", "blocked", "errored", "review", "triaged"];
export const DEFAULT_FIELDS = [
  "id", "url", "title", "status", "category", "priority", "action", "expiresAt", "expiryReason",
  "readMinutes", "needsBrowser",
];

function rec(x: unknown): Raw {
  return x as Raw;
}
function has(o: Raw, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}
function jraw(x: unknown): string {
  return typeof x === "string" ? x : "null";
}

// ---------------------------------------------------------------- projection

function fieldKV(o: Raw, f: string): string | null {
  const key = JSON.stringify(f) + ":";
  if (f === "id") return key + jnum(num(o["id"]));
  if (f === "url") return key + jstr(str(o["url"]));
  if (f === "urlHash") return key + jstr(str(o["url_hash"]));
  if (f === "title") return key + jstr(str(o["title"]));
  if (f === "source") return key + jstr(str(o["source"]));
  if (f === "addedAt") return key + isoOrNull(num(o["added_at"]));
  if (f === "note") return key + jstr(str(o["note"]));
  if (f === "tags") return key + jraw(o["tags"]);
  if (f === "extracted_content") return key + jstr(str(o["extracted_content"]));
  if (f === "extractedAt") return key + isoOrNull(num(o["extracted_at"]));
  if (f === "enrichment") return key + jraw(o["enrichment"]);
  if (f === "expiresAt") return key + isoOrNull(num(o["expires_at"]));
  if (f === "expiryReason") return key + jstr(str(o["expiry_reason"]));
  if (f === "status") return key + jstr(str(o["status"]));
  if (f === "category") return key + jstr(str(o["category"]));
  if (f === "priority") return key + jstr(str(o["priority"]));
  if (f === "action") return key + jstr(str(o["action"]));
  if (f === "confidence") return key + jnum(num(o["confidence"]));
  if (f === "readMinutes") return key + jnum(num(o["read_minutes"]));
  if (f === "needsBrowser") return key + (num(o["needs_browser"]) === 1 ? "true" : "false");
  if (f === "createdAt") return key + isoOrNull(num(o["created_at"]));
  if (f === "updatedAt") return key + isoOrNull(num(o["updated_at"]));
  if (f === "state") return key + jstr(str(o["state"]));
  if (f === "stateData") return key + jraw(o["state_data"]);
  if (f === "mediaReport") return key + jraw(o["media_report"]);
  return null;
}

export function projectJson(row: unknown, fields: string[]): string {
  const o = rec(row);
  const use = fields.length > 0 ? fields : DEFAULT_FIELDS;
  const seen: string[] = [];
  const parts: string[] = [];
  for (const f of use) {
    if (seen.indexOf(f) >= 0) continue;
    seen.push(f);
    const kv = fieldKV(o, f);
    if (kv !== null) parts.push(kv);
  }
  return "{" + parts.join(",") + "}";
}

export function splitFields(s: string): string[] {
  const out: string[] = [];
  if (s === "") return out;
  for (const part of s.split(",")) out.push(part.trim());
  return out;
}

// ------------------------------------------------------------------- list

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
}

// Port of toFts5Query: letter/number runs, de-duplicated case-insensitively, prefix match, AND.
// Non-ASCII code units count as word characters (the Node side uses \p{L}\p{N}).
export function ftsQuery(text: string): string | null {
  const terms: string[] = [];
  const seen: string[] = [];
  let cur = "";
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 0;
    if (i < text.length && isAlnum(c)) {
      cur += text.charAt(i);
    } else if (cur !== "") {
      const key = cur.toLowerCase();
      if (seen.indexOf(key) < 0) {
        seen.push(key);
        terms.push('"' + cur + '"*');
      }
      cur = "";
    }
  }
  return terms.length > 0 ? terms.join(" AND ") : null;
}

export class ListOpts {
  status: string | null = null;
  byState = false;
  category: string | null = null;
  stale = false;
  q: string | null = null;
  limit = -1;
  offset = 0;
}

export function listRows(o: ListOpts): unknown[] {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (o.status !== null) {
    conds.push(o.byState ? "state = ?" : "status = ?");
    params.push(o.status);
  }
  if (o.category !== null) {
    conds.push("category = ?");
    params.push(o.category);
  }
  if (o.stale) {
    conds.push("expires_at IS NOT NULL AND expires_at < ?");
    params.push(Date.now());
  }
  let order = "created_at DESC, id DESC";
  const orderParams: (string | number)[] = [];
  if (o.q !== null) {
    const fq = ftsQuery(o.q);
    if (fq === null) return [];
    conds.push("id IN (SELECT rowid FROM links_fts WHERE links_fts MATCH ?)");
    params.push(fq);
    order =
      "(SELECT bm25(links_fts, 10.0, 1.0, 3.0, 2.0, 5.0) FROM links_fts WHERE links_fts.rowid = links.id AND links_fts MATCH ?) ASC, created_at DESC, id DESC";
    orderParams.push(fq);
  }
  let sql = "SELECT * FROM links";
  if (conds.length > 0) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY " + order;
  const all: (string | number)[] = [];
  for (const p of params) all.push(p);
  for (const p of orderParams) all.push(p);
  if (o.limit >= 0) {
    sql += " LIMIT ?";
    all.push(o.limit);
    if (o.offset > 0) {
      sql += " OFFSET ?";
      all.push(o.offset);
    }
  } else if (o.offset > 0) {
    sql += " LIMIT -1 OFFSET ?";
    all.push(o.offset);
  }
  const st = getDb().prepareRaw(sql);
  const rows = st.allRaw(all);
  st.finalize();
  return rows;
}

export function listJsonArray(o: ListOpts, fields: string[]): string {
  const parts: string[] = [];
  for (const r of listRows(o)) parts.push(projectJson(r, fields));
  return "[" + parts.join(",") + "]";
}

export function getRow(id: number): unknown {
  const st = getDb().prepareRaw("SELECT * FROM links WHERE id = ?");
  const r = st.getRaw([id]);
  st.finalize();
  return r === undefined ? null : r;
}

// Batch filter syntax of the MCP `filter` argument: `status:archived category:job stale:1`.
// Applied to the projected rows, so a clause on a field the projection lacks does not match.
export function filterMatches(row: unknown, filter: string): boolean {
  const o = rec(row);
  for (const clause of filter.split(" ")) {
    const c = clause.trim();
    if (c === "") continue;
    const at = c.indexOf(":");
    const key = at >= 0 ? c.slice(0, at) : c;
    const value = at >= 0 ? c.slice(at + 1) : "";
    let ok = false;
    if (key === "status") ok = str(o["status"]) === value;
    else if (key === "category") ok = str(o["category"]) === value;
    else if (key === "stale") ok = value === "" || value === "1" || value === "true";
    else ok = (str(o["title"]) ?? "").toLowerCase().indexOf(c.toLowerCase()) >= 0;
    if (!ok) return false;
  }
  return true;
}

// ------------------------------------------------------------- park reasons

function startsWith(s: string, p: string): boolean {
  return s.length >= p.length && s.slice(0, p.length) === p;
}
function isDigits3(s: string): boolean {
  if (s.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

export function parseParkReason(value: string | null): string {
  if (value === null) return "unknown";
  let s = value.trim();
  if (s === "") return "unknown";
  if (startsWith(s, "blocked:")) s = s.slice(8).trim();
  else if (startsWith(s, "canary_flagged:")) s = s.slice(15).trim();
  const cut = s.indexOf(" (");
  if (cut > 0) s = s.slice(0, cut).trim();
  if (s === "") return "unknown";
  if (PARK_REASONS.indexOf(s) >= 0) return s;
  if (s === "skip_host") return "skipped";
  const login = ["login_wall", "private_404", "private_410", "login", "signin", "login_required"];
  const bot = ["bot_block", "blocked_text", "captcha", "challenge", "cloudflare", "http_403", "http_429", "http_999"];
  const tmo = ["timeout", "timed_out", "etimedout", "http_408", "http_504"];
  const shell = ["js_shell", "empty_page", "empty", "shell"];
  if (login.indexOf(s) >= 0) return "login_wall";
  if (bot.indexOf(s) >= 0) return "bot_block";
  if (tmo.indexOf(s) >= 0) return "timeout";
  if (shell.indexOf(s) >= 0) return "js_shell";
  if (startsWith(s, "http_") && isDigits3(s.slice(5))) {
    const code = Number(s.slice(5));
    if (code === 403 || code === 429 || code === 999) return "bot_block";
    if (code === 408 || code === 504) return "timeout";
    return "http_error";
  }
  return "unknown";
}

class StateData {
  present = false;
  reason: string | null = null; // reason ?? error, when a string
  reasonRaw = false; // reason/error present but not a string
  reasonClass: string | null = null;
  enriched = false;
  nextAttemptAt: string | null = null;
}

function readStateData(text: string | null): StateData {
  const sd = new StateData();
  if (text === null) return sd;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return sd;
  }
  if (parsed === null || typeof parsed !== "object") return sd;
  sd.present = true;
  const o = rec(parsed);
  let v: unknown = null;
  if (has(o, "reason") && o["reason"] !== null) v = o["reason"];
  else if (has(o, "error")) v = o["error"];
  if (typeof v === "string") sd.reason = v;
  if (has(o, "reasonClass") && typeof o["reasonClass"] === "string") sd.reasonClass = o["reasonClass"] as string;
  if (has(o, "enriched") && o["enriched"] === true) sd.enriched = true;
  if (has(o, "nextAttemptAt") && typeof o["nextAttemptAt"] === "string") sd.nextAttemptAt = o["nextAttemptAt"] as string;
  return sd;
}

function parkReasonOfData(sd: StateData): string {
  if (!sd.present) return "unknown";
  return parseParkReason(sd.reason);
}

// null when the link is not parked
function parkedReasonOf(state: string, sd: StateData): string | null {
  if (state === "needs_browser") return parkReasonOfData(sd);
  if (state === "deferred") {
    const r = parkReasonOfData(sd);
    return r === "unknown" ? null : r;
  }
  return null;
}

function reasonOfStateData(sd: StateData): string | null {
  if (!sd.present || sd.reason === null || sd.reason === "") return null;
  const cleaned = startsWith(sd.reason, "blocked:") ? sd.reason.slice(8) : sd.reason;
  return cleaned === "" ? null : cleaned;
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch (e) {
    return "";
  }
}

// ---------------------------------------------------------------- collections

function reasonClassOf(sd: StateData): string {
  if (!sd.present) return "unknown";
  if (sd.reasonClass !== null && PARK_REASONS.indexOf(sd.reasonClass) >= 0) return sd.reasonClass;
  if (sd.reason !== null) return parseParkReason(sd.reason);
  return "unknown";
}

function collectionOf(state: string, sd: StateData, hasEnrichment: boolean, hasCategory: boolean): string | null {
  if (state === "created" || state === "extracting" || state === "extracted" || state === "enriching") return "pending";
  if (state === "inbox") return hasEnrichment || sd.enriched || hasCategory ? "enriched" : "pending";
  if (state === "deferred") {
    const cls = reasonClassOf(sd);
    if (cls === "unknown") return "pending";
    if (cls === "login_wall") return "needs_login";
    if (cls === "review_only") return "review";
    return "blocked";
  }
  if (state === "needs_browser") {
    const cls = reasonClassOf(sd);
    if (cls === "login_wall") return "needs_login";
    if (cls === "review_only") return "review";
    return "blocked";
  }
  if (state === "errored") return "errored";
  if (state === "scheduled" || state === "archived" || state === "discarded") return "triaged";
  return null;
}

export function collectionsSummaryJson(): string {
  const st = getDb().prepareRaw("SELECT url, state, state_data, enrichment, category FROM links");
  const rows = st.allRaw([]);
  st.finalize();
  const counts: number[] = [];
  for (let i = 0; i < COLLECTIONS.length; i++) counts.push(0);
  let total = 0;
  const hosts: string[] = [];
  const hostCounts: number[] = [];
  for (const raw of rows) {
    const o = rec(raw);
    const state = str(o["state"]) ?? "";
    const sd = readStateData(str(o["state_data"]));
    const c = collectionOf(state, sd, str(o["enrichment"]) !== null, str(o["category"]) !== null);
    if (c === null) continue;
    total += 1;
    counts[COLLECTIONS.indexOf(c)] += 1;
    if (c === "needs_login") {
      const h = hostOfUrl(str(o["url"]) ?? "");
      const at = hosts.indexOf(h);
      if (at < 0) {
        hosts.push(h);
        hostCounts.push(1);
      } else hostCounts[at] += 1;
    }
  }
  // count desc, then host asc (insertion sort keeps the two arrays in step)
  for (let i = 1; i < hosts.length; i++) {
    let j = i;
    while (j > 0 && (hostCounts[j] > hostCounts[j - 1] || (hostCounts[j] === hostCounts[j - 1] && hosts[j] < hosts[j - 1]))) {
      const th = hosts[j]; hosts[j] = hosts[j - 1]; hosts[j - 1] = th;
      const tc = hostCounts[j]; hostCounts[j] = hostCounts[j - 1]; hostCounts[j - 1] = tc;
      j--;
    }
  }
  const cparts: string[] = [];
  for (let i = 0; i < COLLECTIONS.length; i++) cparts.push(JSON.stringify(COLLECTIONS[i]) + ":" + counts[i]);
  const hparts: string[] = [];
  for (let i = 0; i < hosts.length; i++) hparts.push('{"host":' + JSON.stringify(hosts[i]) + ',"count":' + hostCounts[i] + "}");
  return '{"total":' + total + ',"collections":{' + cparts.join(",") + '},"needsLoginHosts":[' + hparts.join(",") + "]}";
}

// ------------------------------------------------------------------- overview

class HostAgg {
  host = "";
  total = 0;
  byState: number[] = [];
  byPark: number[] = [];
}

function zeros(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(0);
  return a;
}
function countsJson(names: string[], counts: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < names.length; i++) parts.push(JSON.stringify(names[i]) + ":" + counts[i]);
  return "{" + parts.join(",") + "}";
}

export function overviewParts(topHosts: number): { byState: string; byPark: string; byHost: string; total: number } {
  const st = getDb().prepareRaw("SELECT url, state, state_data FROM links ORDER BY created_at DESC, id DESC");
  const rows = st.allRaw([]);
  st.finalize();
  const byState = zeros(STATES.length);
  const byPark = zeros(PARK_REASONS.length);
  const hosts: HostAgg[] = [];
  let total = 0;
  for (const raw of rows) {
    const o = rec(raw);
    const state = str(o["state"]) ?? "created";
    const sd = readStateData(str(o["state_data"]));
    const si = STATES.indexOf(state);
    total += 1;
    if (si >= 0) byState[si] += 1;
    const park = parkedReasonOf(state, sd);
    if (park !== null) byPark[PARK_REASONS.indexOf(park)] += 1;
    const host = hostOfUrl(str(o["url"]) ?? "");
    if (host === "") continue;
    let agg: HostAgg | null = null;
    for (const h of hosts) if (h.host === host) agg = h;
    if (agg === null) {
      agg = new HostAgg();
      agg.host = host;
      agg.byState = zeros(STATES.length);
      agg.byPark = zeros(PARK_REASONS.length);
      hosts.push(agg);
    }
    agg.total += 1;
    if (si >= 0) agg.byState[si] += 1;
    if (park !== null) agg.byPark[PARK_REASONS.indexOf(park)] += 1;
  }
  for (let i = 1; i < hosts.length; i++) {
    let j = i;
    while (j > 0 && (hosts[j].total > hosts[j - 1].total || (hosts[j].total === hosts[j - 1].total && hosts[j].host < hosts[j - 1].host))) {
      const t = hosts[j]; hosts[j] = hosts[j - 1]; hosts[j - 1] = t;
      j--;
    }
  }
  const hparts: string[] = [];
  for (let i = 0; i < hosts.length && i < topHosts; i++) {
    const h = hosts[i];
    hparts.push(
      '{"host":' + JSON.stringify(h.host) + ',"total":' + h.total + ',"byState":' + countsJson(STATES, h.byState) +
        ',"byParkReason":' + countsJson(PARK_REASONS, h.byPark) + "}",
    );
  }
  return { byState: countsJson(STATES, byState), byPark: countsJson(PARK_REASONS, byPark), byHost: "[" + hparts.join(",") + "]", total: total };
}

// CLI order (byState, byParkReason, byHost, total)
export function overviewCliJson(topHosts: number): string {
  const p = overviewParts(topHosts);
  return '{"byState":' + p.byState + ',"byParkReason":' + p.byPark + ',"byHost":' + p.byHost + ',"total":' + p.total + "}";
}
// MCP order (total, byState, byParkReason, byHost)
export function overviewMcpJson(topHosts: number): string {
  const p = overviewParts(topHosts);
  return '{"total":' + p.total + ',"byState":' + p.byState + ',"byParkReason":' + p.byPark + ',"byHost":' + p.byHost + "}";
}

// -------------------------------------------------------------------- pipeline

export function pipelineJson(state: string | null, host: string | null, q: string | null, limit: number, offset: number): string {
  const o = new ListOpts();
  if (state !== null) {
    o.status = state;
    o.byState = true;
  }
  const rows = listRows(o);
  const parts: string[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const r = rec(raw);
    const url = str(r["url"]) ?? "";
    const title = str(r["title"]) ?? "";
    const h = hostOfUrl(url);
    if (host !== null && host !== "" && h !== host.toLowerCase()) continue;
    if (q !== null && q !== "") {
      const lq = q.toLowerCase();
      if (url.toLowerCase().indexOf(lq) < 0 && title.toLowerCase().indexOf(lq) < 0) continue;
    }
    if (skipped < offset) {
      skipped++;
      continue;
    }
    if (limit >= 0 && parts.length >= limit) break;
    const st = str(r["state"]) ?? "created";
    const sd = readStateData(str(r["state_data"]));
    const park = parkedReasonOf(st, sd);
    const reason = reasonOfStateData(sd);
    parts.push(
      '{"id":' + jnum(num(r["id"])) + ',"url":' + JSON.stringify(url) + ',"host":' + JSON.stringify(h) +
        ',"title":' + JSON.stringify(title) + ',"state":' + JSON.stringify(st) + ',"reason":' + jstr(reason) +
        ',"parkReason":' + jstr(park) + ',"nextAttemptAt":' + jstr(sd.nextAttemptAt) +
        ',"updatedAt":' + JSON.stringify(new Date(num(r["updated_at"]) ?? 0).toISOString()) + "}",
    );
  }
  return "[" + parts.join(",") + "]";
}

// ------------------------------------------------------------------- history

export function historyEntries(id: number): { at: string; event: string; from: string; to: string }[] {
  const st = getDb().prepareRaw("SELECT from_state, to_state, event, at FROM link_events WHERE link_id = ? ORDER BY id ASC");
  const rows = st.allRaw([id]);
  st.finalize();
  const out: { at: string; event: string; from: string; to: string }[] = [];
  for (const raw of rows) {
    const o = rec(raw);
    out.push({
      at: new Date(num(o["at"]) ?? 0).toISOString(),
      event: str(o["event"]) ?? "",
      from: str(o["from_state"]) ?? "",
      to: str(o["to_state"]) ?? "",
    });
  }
  return out;
}

// -------------------------------------------------------------------- render

export function renderTable(headers: string[], rows: string[][]): string {
  const widths: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    let w = headers[i].length;
    for (const r of rows) if (r[i].length > w) w = r[i].length;
    widths.push(w);
  }
  const line = (cells: string[]): string => {
    const out: string[] = [];
    for (let i = 0; i < cells.length; i++) out.push(cells[i].padEnd(widths[i]));
    return out.join("  ");
  };
  const divider: string[] = [];
  for (const w of widths) divider.push("-".repeat(w));
  const lines: string[] = [line(headers), divider.join("  ")];
  for (const r of rows) lines.push(line(r));
  return lines.join("\n");
}

export function shortDate(v: string | null): string {
  return v === null ? "" : v.slice(0, 10);
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function formatOverview(json: string): string {
  const ov = JSON.parse(json) as Raw;
  const stateRows: string[][] = [];
  const bs = rec(ov["byState"]);
  for (const s of STATES) stateRows.push([s, String(bs[s])]);
  const bp = rec(ov["byParkReason"]);
  const reasonRows: string[][] = [];
  for (const r of PARK_REASONS) if ((bp[r] as number) > 0) reasonRows.push([r, String(bp[r])]);
  const hostRows: string[][] = [];
  for (const hRaw of ov["byHost"] as unknown[]) {
    const h = rec(hRaw);
    const hs = rec(h["byState"]);
    const hp = rec(h["byParkReason"]);
    const sp: string[] = [];
    for (const s of STATES) if ((hs[s] as number) > 0) sp.push(s + ":" + hs[s]);
    const pp: string[] = [];
    for (const r of PARK_REASONS) if ((hp[r] as number) > 0) pp.push(r + ":" + hp[r]);
    hostRows.push([h["host"] as string, String(h["total"]), sp.join(" "), pp.join(" ")]);
  }
  const total = ov["total"] as number;
  return [
    total + " link" + (total === 1 ? "" : "s"),
    "",
    renderTable(["state", "count"], stateRows),
    "",
    reasonRows.length > 0 ? renderTable(["park reason", "count"], reasonRows) : "no parked links",
    "",
    hostRows.length > 0 ? renderTable(["host", "total", "states", "park reasons"], hostRows) : "no hosts",
  ].join("\n");
}

// state, reason and retry columns of `list --state`
export function stateCols(row: unknown): string[] {
  const r = rec(row);
  const sd = readStateData(str(r["state_data"]));
  return [str(r["state"]) ?? "created", reasonOfStateData(sd) ?? "", shortDate(sd.nextAttemptAt)];
}

export const SHOW_FIELDS = [
  "id", "url", "title", "source", "addedAt", "tags", "note", "status", "state", "stateData", "category",
  "priority", "action", "confidence", "readMinutes", "expiresAt", "expiryReason", "needsBrowser",
  "extractedAt", "enrichment", "mediaReport", "extracted_content",
];
export const STATE_LIST_FIELDS = ["id", "url", "title", "status", "category", "expiresAt", "state", "stateData"];
