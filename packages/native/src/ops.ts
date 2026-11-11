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
  type TriageAction,
  type SweepPlan,
} from "@atento/core";
import { CutilsDriver } from "./cutils-driver.ts";
import { loadPolicy } from "./config.ts";

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
