/// <reference path="./shims.d.ts" />
// Native write and aggregate ops: the portable SqlStore (over @cutils/sqlite) plus the shared core functions.
import { SqlStore } from "@atento/db/sql";
import { triage, restore, sweep, applySweep, metricsSummary, DEFAULT_TTL_CONFIG } from "@atento/core";
import type { TriageAction, SweepPlan } from "@atento/core";
import { CutilsDriver } from "./cutils-driver.ts";

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
