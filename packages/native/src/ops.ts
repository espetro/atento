/// <reference path="./shims.d.ts" />
// Native write and aggregate ops: the portable SqlStore (over @cutils/sqlite) plus the shared core functions.
import { SqlStore } from "@atento/db/sql";
import {
  triage,
  restore,
  sweep,
  applySweep,
  metricsSummary,
  DEFAULT_TTL_CONFIG,
  listHostsNeedingLogin,
  countReviewOnlyLinks,
  guardDepsFromStore,
  guardStatuses,
  LLM_KEY,
  collectionOfLink,
  isCollectionName,
  LINK_STATES,
  type Link,
  type TriageAction,
  type SweepPlan,
} from "@atento/core";
import { CutilsDriver } from "./cutils-driver.ts";
import { loadPolicy } from "./config.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const TRIAGE_ACTIONS = ["read_now", "schedule", "archive", "discard"];

let cachedStore: SqlStore | null = null;

/** Writable store, opened lazily and migrated like the Node openStore. */
export async function openStore(): Promise<SqlStore> {
  if (cachedStore !== null) return cachedStore;
  const path = process.env.ATENTO_DB ?? "/tmp/atento-spike/a.db";
  const s = new SqlStore(CutilsDriver.open(path, false));
  await s.migrate();
  cachedStore = s;
  return s;
}

export async function closeStore(): Promise<void> {
  if (cachedStore !== null) await cachedStore.close();
  cachedStore = null;
}

export interface TriageOut {
  requested: number[];
  updated: number;
  status: string;
  missing: number[];
}

export async function doTriage(ids: number[], action: string): Promise<TriageOut> {
  const s = await openStore();
  const r = await triage(s, ids, action as TriageAction);
  return { requested: r.requested, updated: r.updated, status: r.status, missing: r.missing };
}

export interface RestoreOut {
  requested: number[];
  updated: number;
  missing: number[];
  blocked: number[];
}

export async function doRestore(ids: number[]): Promise<RestoreOut> {
  const s = await openStore();
  const r = await restore(s, ids);
  return { requested: r.requested, updated: r.updated, missing: r.missing, blocked: r.blocked };
}

export async function doSweepPlan(): Promise<SweepPlan> {
  const s = await openStore();
  return sweep(s, DEFAULT_TTL_CONFIG);
}

export async function doApplySweep(plan: SweepPlan): Promise<number> {
  const s = await openStore();
  return applySweep(s, plan);
}

/** JSON.stringify of a plan, dates as ISO strings (same bytes as the Node JSON.stringify). */
export function planJson(plan: SweepPlan): string {
  const groups: string[] = [];
  for (const g of plan.groups) {
    const items: string[] = [];
    for (const i of g.items) {
      items.push(
        '{"linkId":' + i.linkId + ',"url":' + JSON.stringify(i.url) + ',"title":' + (i.title === null ? "null" : JSON.stringify(i.title)) +
          ',"category":' + (i.category === null ? "null" : JSON.stringify(i.category)) +
          ',"expiresAt":' + JSON.stringify(i.expiresAt.toISOString()) +
          ',"expiryReason":' + (i.expiryReason === null ? "null" : JSON.stringify(i.expiryReason)) +
          ',"action":' + JSON.stringify(i.action) + ',"pruneEligible":' + (i.pruneEligible ? "true" : "false") + "}",
      );
    }
    groups.push('{"category":' + JSON.stringify(g.category) + ',"action":' + JSON.stringify(g.action) + ',"items":[' + items.join(",") + "]}");
  }
  return '{"groups":[' + groups.join(",") + '],"totals":{"archive":' + plan.totals.archive + "}}";
}

export async function metricsJson(range: string): Promise<string> {
  const s = await openStore();
  const m = await metricsSummary(s, range);
  return JSON.stringify(m);
}

/** Age of a saved profile in whole days, never negative (same as app pending-logins). */
function profileAgeDays(updatedAt: Date, now: Date = new Date()): number {
  const days = (now.getTime() - updatedAt.getTime()) / 86_400_000;
  return Math.max(0, Math.floor(days));
}

/**
 * login.pending: hosts still needing a browser login (waiting link counts,
 * reasons) plus hosts that already have a saved profile with its age.
 * Same report shape as packages/app buildLoginReport.
 */
export async function loginPendingJson(): Promise<string> {
  const s = await openStore();
  const pol = loadPolicy();
  const policy = { limits: pol.limits, loginAllow: pol.login.allow };
  const profiles = await s.listProfiles();
  const profileHosts: string[] = [];
  for (const p of profiles) profileHosts.push(p.host);
  const pending = (await listHostsNeedingLogin(s, policy))
    .filter((h) => profileHosts.indexOf(h.host) < 0)
    .sort((a, b) => b.linkCount - a.linkCount || a.host.localeCompare(b.host));
  const done = profiles
    .map((p) => ({ host: p.host, profileAgeDays: profileAgeDays(p.updatedAt) }))
    .sort((a, b) => a.host.localeCompare(b.host));
  const reviewOnly = await countReviewOnlyLinks(s, policy);
  const pjson: string[] = [];
  for (const p of pending) {
    pjson.push('{"host":' + JSON.stringify(p.host) + ',"links":' + p.linkCount + ',"reason":' + JSON.stringify(p.reason) + "}");
  }
  const djson: string[] = [];
  for (const d of done) {
    djson.push('{"host":' + JSON.stringify(d.host) + ',"profileAgeDays":' + d.profileAgeDays + "}");
  }
  return '{"pending":[' + pjson.join(",") + '],"done":[' + djson.join(",") + '],"reviewOnly":' + reviewOnly + "}";
}

/**
 * limits.status: rate-limit budget and circuit breaker state per tracked
 * host key plus the llm key. Read-only; same row shape as the Node tool.
 */
export async function limitsStatusJson(): Promise<string> {
  const s = await openStore();
  const states = await s.listHostStates();
  const keys: string[] = [];
  for (const st of states) {
    if (keys.indexOf(st.key) < 0) keys.push(st.key);
  }
  if (keys.indexOf(LLM_KEY) < 0) keys.push(LLM_KEY);
  keys.sort();
  // Node limits_status goes through ops.guardDeps() with no overrides, i.e.
  // DEFAULT_GUARD_CONFIG — user config.toml limits do not apply here.
  const deps = guardDepsFromStore(s);
  const rows = await guardStatuses(deps, keys);
  const out: string[] = [];
  for (const row of rows) {
    const dailyCap = row.dailyCap === Number.POSITIVE_INFINITY ? "unlimited" : row.dailyCap;
    const remaining =
      row.remainingToday === Number.POSITIVE_INFINITY ? "unlimited" : row.remainingToday;
    out.push(
      '{"key":' + JSON.stringify(row.key) +
        ',"breakerState":' + JSON.stringify(row.breakerState) +
        ',"reopensAt":' + (row.reopensAt === null ? "null" : JSON.stringify(row.reopensAt)) +
        ',"dailyCap":' + JSON.stringify(dailyCap) +
        ',"remainingToday":' + JSON.stringify(remaining) +
        ',"lastRequestAt":' + (row.lastRequestAt === null ? "null" : JSON.stringify(row.lastRequestAt)) +
        ',"consecutiveFailures":' + row.consecutiveFailures +
        ',"lastError":' + (row.lastError === null ? "null" : JSON.stringify(row.lastError)) +
        ',"trialState":' + JSON.stringify(row.trialState) +
        ',"trialReason":' + (row.trialReason === null ? "null" : JSON.stringify(row.trialReason)) +
        ',"rateLimitedUntil":' + (row.rateLimitedUntil === null ? "null" : JSON.stringify(row.rateLimitedUntil)) +
        ',"policy":' + JSON.stringify(row.policy) + "}",
    );
  }
  return '{"hosts":[' + out.join(",") + "]}";
}

// ---------------------------------------------------------------- collections

/** Collection fields a row can project (same list as the Node tool schema). */
export const COLLECTION_FIELD_NAMES = [
  "id", "url", "url_hash", "title", "source", "added_at", "note", "tags",
  "category", "priority", "action", "confidence", "read_minutes", "status",
  "state", "reason", "needs_browser", "expires_at", "expiry_reason",
  "why_it_matters", "summary", "created_at", "updated_at",
];

const DEFAULT_COLLECTION_FIELDS = ["id", "url", "title", "category", "priority", "summary"];
const COLLECTION_READ_DEFAULT_LIMIT = 50;
const COLLECTION_READ_MAX_LIMIT = 200;

function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function stateReasonOf(link: Link): string | null {
  const data = link.stateData;
  if (data === null) return null;
  const reason = data["reason"];
  return typeof reason === "string" ? reason : null;
}

function whyItMattersOf(link: Link): string | null {
  const enrichment = link.enrichment;
  if (enrichment === null) return null;
  const value = (enrichment as unknown as Record<string, unknown>)["why_it_matters"];
  return typeof value === "string" ? value : null;
}

/** projectCollectionRow from packages/app/src/collections.ts, field order preserved. */
function projectCollectionRow(link: Link, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    switch (field) {
      case "id": out["id"] = link.id; break;
      case "url": out["url"] = link.url; break;
      case "url_hash": out["url_hash"] = link.urlHash; break;
      case "title": out["title"] = link.title; break;
      case "source": out["source"] = link.source; break;
      case "added_at": out["added_at"] = isoOrNull(link.addedAt); break;
      case "note": out["note"] = link.note; break;
      case "tags": out["tags"] = link.tags; break;
      case "category": out["category"] = link.category; break;
      case "priority": out["priority"] = link.priority; break;
      case "action": out["action"] = link.action; break;
      case "confidence": out["confidence"] = link.confidence; break;
      case "read_minutes": out["read_minutes"] = link.readMinutes; break;
      case "status": out["status"] = link.status; break;
      case "state": out["state"] = link.state; break;
      case "reason": out["reason"] = stateReasonOf(link); break;
      case "needs_browser": out["needs_browser"] = link.needsBrowser; break;
      case "expires_at": out["expires_at"] = isoOrNull(link.expiresAt); break;
      case "expiry_reason": out["expiry_reason"] = link.expiryReason; break;
      case "why_it_matters": out["why_it_matters"] = whyItMattersOf(link); break;
      case "summary": {
        const summary = whyItMattersOf(link);
        out["summary"] = summary === null ? null : summary.slice(0, 200);
        break;
      }
      case "created_at": out["created_at"] = isoOrNull(link.createdAt); break;
      case "updated_at": out["updated_at"] = isoOrNull(link.updatedAt); break;
      default: break;
    }
  }
  return out;
}

/** TSV body + `# cursor:` trailer, same bytes as serializeCollection + tsvWithCursor. */
function collectionTsv(rows: Record<string, unknown>[], fields: string[], cursor: number): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? (v as unknown[]).join(",") : String(v);
    return s.replace(/[\t\n\r]/g, " ");
  };
  const lines: string[] = [fields.join("\t")];
  for (const row of rows) {
    const cells: string[] = [];
    for (const f of fields) cells.push(esc(row[f]));
    lines.push(cells.join("\t"));
  }
  return lines.join("\n") + "\n" + "# cursor: " + cursor + "\n";
}

/** matchCollection from packages/app/src/collections.ts: links in one collection, id-ordered. */
async function matchCollectionLinks(s: SqlStore, name: string, since: number | undefined): Promise<Link[]> {
  let matched: Link[];
  if (since !== undefined) {
    const changed = await s.listChangedLinks(since);
    matched = [];
    for (const l of changed) if (collectionOfLink(l) === name) matched.push(l);
  } else {
    const states = LINK_STATES.filter((st) => st !== "deleted");
    const live = await s.listByStates(states);
    matched = [];
    for (const l of live) if (collectionOfLink(l) === name) matched.push(l);
  }
  matched.sort((a, b) => a.id - b.id);
  return matched;
}

export interface CollectionReadIn {
  since?: number;
  fields?: string[];
  format?: string;
  limit?: number;
  offset?: number;
}

/**
 * collections.read: paginated inline read of one collection (json or tsv).
 * Returns the exact text payload the Node tool wraps in its json() result.
 */
export async function collectionReadText(name: string, o: CollectionReadIn): Promise<string> {
  if (!isCollectionName(name)) throw new Error("unknown collection: " + name);
  const s = await openStore();
  const limit = Math.min(Math.max(1, o.limit ?? COLLECTION_READ_DEFAULT_LIMIT), COLLECTION_READ_MAX_LIMIT);
  const offset = Math.max(0, o.offset ?? 0);
  const fields = o.fields !== undefined ? o.fields : DEFAULT_COLLECTION_FIELDS;
  for (const f of fields) {
    if (COLLECTION_FIELD_NAMES.indexOf(f) < 0) throw new Error("unknown collection field: " + f);
  }
  const matched = await matchCollectionLinks(s, name, o.since);
  const page = matched.slice(offset, offset + limit);
  const hasMore = offset + limit < matched.length;
  const cursor = o.since !== undefined && hasMore ? o.since : await s.linkEventCursor();
  const rows: Record<string, unknown>[] = [];
  for (const l of page) rows.push(projectCollectionRow(l, fields));
  if (o.format === "tsv") return collectionTsv(rows, fields, cursor);
  return JSON.stringify({
    collection: name,
    cursor: cursor,
    count: page.length,
    total: matched.length,
    hasMore: hasMore,
    rows: rows,
  });
}

// ---------------------------------------------------------------- collection export

function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? (v as unknown[]).join(",") : String(v);
  return s.replace(/[\t\n\r]/g, " ");
}

function mdCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? (v as unknown[]).join(", ") : String(v);
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** serializeCollection from packages/app/src/collections.ts (rows pre-projected). */
function serializeCollectionRows(rows: Record<string, unknown>[], fields: string[], format: string): string {
  if (format === "jsonl") {
    const parts: string[] = [];
    for (const r of rows) parts.push(JSON.stringify(r));
    return parts.join("\n") + (rows.length > 0 ? "\n" : "");
  }
  if (format === "tsv") {
    const lines: string[] = [fields.join("\t")];
    for (const row of rows) {
      const cells: string[] = [];
      for (const f of fields) cells.push(tsvCell(row[f]));
      lines.push(cells.join("\t"));
    }
    return lines.join("\n") + "\n";
  }
  // markdown: a pipe table, one row per link.
  const header = "| " + fields.join(" | ") + " |";
  const sepFields: string[] = [];
  for (const _f of fields) sepFields.push("---");
  const sep = "| " + sepFields.join(" | ") + " |";
  const body: string[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const f of fields) cells.push(mdCell(row[f]));
    body.push("| " + cells.join(" | ") + " |");
  }
  return [header, sep].concat(body).join("\n") + "\n";
}

export interface CollectionExportIn {
  since?: number;
  fields?: string[];
  format?: string;
}

/**
 * collections.export: write one collection (or delta) to
 * <config dir>/exports/<name>-<cursor>.<ext>; returns the Node result shape.
 */
export async function collectionExportText(name: string, o: CollectionExportIn): Promise<string> {
  if (!isCollectionName(name)) throw new Error("unknown collection: " + name);
  const format = o.format !== undefined ? o.format : "jsonl";
  if (format !== "jsonl" && format !== "md" && format !== "tsv") {
    throw new Error("unknown export format: " + format);
  }
  const fields = o.fields !== undefined ? o.fields : DEFAULT_COLLECTION_FIELDS;
  const s = await openStore();
  const matched = await matchCollectionLinks(s, name, o.since);
  const rows: Record<string, unknown>[] = [];
  for (const l of matched) rows.push(projectCollectionRow(l, fields));
  const body = serializeCollectionRows(rows, fields, format);
  const bytes = new TextEncoder().encode(body).length;
  const cursor = await s.linkEventCursor();
  const ext = format === "jsonl" ? "jsonl" : format;
  const file = name + "-" + cursor + "." + ext;
  // Node MCP builds ops without dir/dbPath, so exportsDir resolves to
  // <tmpdir>/atento-exports — match it exactly.
  const dir = join(tmpdir(), "atento-exports");
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, body, "utf8");
  return JSON.stringify({
    collection: name,
    path: path,
    uri: "atento://exports/" + file,
    count: rows.length,
    bytes: bytes,
    cursor: cursor,
    format: format,
  });
}
