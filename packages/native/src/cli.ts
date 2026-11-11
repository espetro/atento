/// <reference path="./shims.d.ts" />
// Native atento CLI over the real schema: list, show, overview, mcp.
import { bool, command, int, runAsync, str } from "@cutils/cli";
import { startMcp } from "./mcpserver.ts";
import { doTriage, doRestore, doSweepPlan, doApplySweep, metricsJson, closeStore, TRIAGE_ACTIONS } from "./ops.ts";
import { renderSweepPlan, renderMetrics } from "./render.ts";
import {
  ListOpts, listRows, projectJson, filterMatches, splitFields, getRow, overviewCliJson, formatOverview, renderTable,
  shortDate, cell, stateCols, historyEntries, SHOW_FIELDS, STATE_LIST_FIELDS, STATES,
} from "./atento.ts";

const STATUSES = ["inbox", "scheduled", "archived", "discarded"];

function fail(msg: string): void {
  console.error("error: " + msg);
  process.exitCode = 1;
}

const code = await runAsync({
  name: "atento",
  version: "0.1.0",
  description: "CLI/MCP-first link triage pipeline (native)",
  commands: {
    list: command("list links", {
      options: {
        status: str({ description: "filter by status" }),
        state: str({ description: "filter by pipeline state" }),
        category: str({ description: "filter by category" }),
        stale: bool({ description: "only stale links" }),
        q: str({ description: "full-text query" }),
        fields: str({ description: "comma-separated fields" }),
        limit: int({ default: -1, description: "cap the number of rows" }),
        json: bool({ description: "print json" }),
      },
      handler: (opts, _args) => {
        if (opts.status !== "" && STATUSES.indexOf(opts.status) < 0) {
          fail('unknown status "' + opts.status + '"; expected one of ' + STATUSES.join(", "));
          return;
        }
        if (opts.state !== "" && STATES.indexOf(opts.state) < 0) {
          fail('unknown state "' + opts.state + '"; expected one of ' + STATES.join(", "));
          return;
        }
        const o = new ListOpts();
        const byState = opts.state !== "";
        if (byState) {
          o.status = opts.state;
          o.byState = true;
        } else if (opts.status !== "") o.status = opts.status;
        if (opts.category !== "") o.category = opts.category;
        o.stale = opts.stale;
        if (opts.q !== "") o.q = opts.q;
        o.limit = opts.limit;
        let fields = splitFields(opts.fields);
        if (fields.length === 0 && byState) fields = STATE_LIST_FIELDS;
        const rows = listRows(o);
        const projected: string[] = [];
        for (const r of rows) projected.push(projectJson(r, fields));
        if (opts.json) {
          console.log(JSON.stringify(JSON.parse("[" + projected.join(",") + "]"), null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log("no links");
          return;
        }
        const headers = byState
          ? ["id", "state", "reason", "retry", "title", "url"]
          : ["id", "status", "category", "expires", "title", "url"];
        const table: string[][] = [];
        for (let i = 0; i < rows.length; i++) {
          const p = JSON.parse(projected[i]) as { [k: string]: unknown };
          if (byState) {
            const c = stateCols(rows[i]);
            table.push([cell(p["id"]), c[0], c[1], c[2], cell(p["title"]), cell(p["url"])]);
          } else {
            table.push([cell(p["id"]), cell(p["status"]), cell(p["category"]), shortDate(cell(p["expiresAt"]) || null), cell(p["title"]), cell(p["url"])]);
          }
        }
        console.log(renderTable(headers, table));
        console.log("\n" + rows.length + " link" + (rows.length === 1 ? "" : "s"));
      },
    }),
    show: command("show one link in full", {
      args: ["id"],
      options: { json: bool({ description: "print json" }) },
      handler: (opts, args) => {
        const id = Number(args[0]);
        const r = getRow(id);
        if (r === null) {
          console.error("no link with id " + args[0]);
          process.exitCode = 1;
          return;
        }
        const obj = JSON.parse(projectJson(r, SHOW_FIELDS)) as { [k: string]: unknown };
        if (opts.json) {
          console.log(JSON.stringify(obj, null, 2));
          return;
        }
        for (const f of SHOW_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(obj, f)) continue;
          if (f === "extracted_content" || f === "mediaReport") continue;
          console.log(f + ": " + cell(obj[f]));
        }
        const content = obj["extracted_content"];
        if (typeof content === "string" && content !== "") {
          console.log("\n--- extracted content ---");
          console.log(content);
        }
        const hist = historyEntries(id);
        if (hist.length > 0) {
          console.log("\n--- history ---");
          for (const h of hist) console.log(h.at + "  " + h.event.padEnd(16) + " " + h.from + " -> " + h.to);
        }
      },
    }),
    overview: command("overview of every link by pipeline state", {
      options: {
        json: bool({ description: "print json" }),
      },
      handler: (opts, _args) => {
        const j = overviewCliJson(50);
        if (opts.json) console.log(JSON.stringify(JSON.parse(j), null, 2));
        else console.log(formatOverview(j));
      },
    }),
    triage: command("triage links (read_now, schedule, archive, discard)", {
      args: [{ name: "ids", optional: true, variadic: true }],
      options: {
        action: str({ description: "read_now, schedule, archive or discard" }),
        batch: bool({ description: "apply to every link matching --filter" }),
        filter: str({ description: "batch filter" }),
      },
      handler: async (opts, args) => {
        if (TRIAGE_ACTIONS.indexOf(opts.action) < 0) {
          fail('unknown action "' + opts.action + '"; expected one of ' + TRIAGE_ACTIONS.join(", "));
          return;
        }
        let ids: number[] = [];
        for (const a of args[0]) ids.push(Number(a));
        if (opts.batch) {
          ids = [];
          const o = new ListOpts();
          for (const r of listRows(o)) {
            const proj = projectJson(r, ["id", "status", "category", "title"]);
            if (opts.filter === "" || filterMatches(JSON.parse(proj), opts.filter)) ids.push(JSON.parse(proj).id as number);
          }
          if (ids.length === 0) {
            console.log("no links matched the filter");
            return;
          }
        }
        if (ids.length === 0) {
          fail("triage needs at least one link id (or --batch with a filter)");
          return;
        }
        const r = await doTriage(ids, opts.action);
        console.log(r.updated + " link" + (r.updated === 1 ? "" : "s") + " -> " + r.status);
        if (r.missing.length > 0) console.log("missing: " + r.missing.join(", "));
        await closeStore();
      },
    }),
    restore: command("restore archived, discarded or errored links to the inbox", {
      args: [{ name: "ids", variadic: true }],
      handler: async (_opts, args) => {
        const ids: number[] = [];
        for (const a of args[0]) ids.push(Number(a));
        const r = await doRestore(ids);
        console.log(r.updated + " link" + (r.updated === 1 ? "" : "s") + " restored to inbox");
        if (r.missing.length > 0) console.log("missing: " + r.missing.join(", "));
        if (r.blocked.length > 0) {
          console.log("blocked (deleted or not restorable): " + r.blocked.join(", "));
          process.exitCode = 1;
        }
        await closeStore();
      },
    }),
    sweep: command("list stale links grouped by category (dry-run by default)", {
      options: { apply: bool({ description: "archive the stale links" }) },
      handler: async (opts, _args) => {
        const plan = await doSweepPlan();
        console.log(renderSweepPlan(plan));
        if (opts.apply && plan.totals.archive > 0) {
          const n = await doApplySweep(plan);
          console.log("archived " + n + " link(s)");
        }
        await closeStore();
      },
    }),
    metrics: command("per-stage counts, durations, tokens and cost", {
      options: {
        last: str({ default: "7d", description: "time range, e.g. 7d, 24h, 2w" }),
        json: bool({ description: "print json" }),
      },
      handler: async (opts, _args) => {
        const j = await metricsJson(opts.last);
        if (opts.json) console.log(JSON.stringify(JSON.parse(j), null, 2));
        else console.log(renderMetrics(j, opts.last));
        await closeStore();
      },
    }),
    mcp: command("serve the MCP server over stdio", {
      handler: (_opts, _args) => {
        startMcp();
      },
    }),
  },
});
if (code !== 0) process.exitCode = code;
