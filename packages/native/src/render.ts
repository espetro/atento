// Text renderers for the native write and aggregate commands, byte-compatible with the Node CLI.
import type { SweepPlan } from "@atento/core";
import { renderTable, shortDate } from "./atento.ts";

export function renderSweepPlan(plan: SweepPlan): string {
  if (plan.totals.archive === 0) return "nothing to sweep";
  const out: string[] = [];
  for (const g of plan.groups) {
    out.push("\n" + g.category + " (" + g.items.length + ")");
    const rows: string[][] = [];
    for (const i of g.items) rows.push([String(i.linkId), shortDate(i.expiresAt.toISOString()), i.title === null ? "" : i.title, i.url]);
    out.push(renderTable(["id", "expires", "title", "url"], rows));
  }
  out.push("\n" + plan.totals.archive + " item(s) would be archived (dry-run; use --apply)");
  return out.join("\n");
}

/** Intl en-US with at most two fraction digits. */
export function formatNumber(n: number): string {
  const neg = n < 0;
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  let w = String(whole);
  let grouped = "";
  while (w.length > 3) {
    grouped = "," + w.slice(w.length - 3) + grouped;
    w = w.slice(0, w.length - 3);
  }
  grouped = w + grouped;
  let f = "";
  if (frac > 0) f = "." + (frac < 10 ? "0" + frac : String(frac)).replace(/0$/, "");
  return (neg ? "-" : "") + grouped + f;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

type Obj = { [k: string]: unknown };

function tagLine(o: Obj): string {
  const parts: string[] = [];
  for (const k of Object.keys(o)) parts.push(k + "=" + String(o[k]));
  return parts.join(" ");
}

export function renderMetrics(json: string, range: string): string {
  const m = JSON.parse(json) as Obj;
  const stages = m["stages"] as Obj[];
  if (stages.length === 0) return "no metrics in the last " + range;
  const rows: string[][] = [];
  for (const s of stages) {
    rows.push([
      String(s["stage"]), String(s["runs"]), String(s["input"]), String(s["ok"]), String(s["errors"]),
      formatNumber(s["avgDurationMs"] as number), formatNumber(s["tokensIn"] as number),
      formatNumber(s["tokensOut"] as number), formatUsd(s["costUsd"] as number),
    ]);
  }
  const out: string[] = [renderTable(["stage", "runs", "in", "ok", "err", "avg ms", "tok in", "tok out", "cost"], rows)];
  for (const s of stages) {
    const e = s["errorsByTag"] as Obj;
    if (Object.keys(e).length > 0) out.push("\n" + String(s["stage"]) + " errors by source: " + tagLine(e));
  }
  for (const s of stages) {
    const c = s["countsByTag"] as Obj;
    if (Object.keys(c).length > 0) out.push("\n" + String(s["stage"]) + " breakdown: " + tagLine(c));
  }
  out.push("\nrange: " + String(m["since"]) + " .. " + String(m["until"]));
  return out.join("\n");
}
