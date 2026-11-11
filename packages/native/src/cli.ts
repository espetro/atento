/// <reference path="./shims.d.ts" />
// Native atento CLI over the real schema: list, show, overview, mcp.
import { bool, command, int, run, str } from "@cutils/cli";
import { startMcp } from "./mcpserver.ts";
import {
  ListOpts, listRows, projectJson, splitFields, getRow, overviewCliJson, formatOverview, renderTable,
  shortDate, cell, stateCols, historyEntries, SHOW_FIELDS, STATE_LIST_FIELDS, STATES,
} from "./atento.ts";

const STATUSES = ["inbox", "scheduled", "archived", "discarded"];

function fail(msg: string): void {
  console.error("error: " + msg);
  process.exitCode = 1;
}

const code = run({
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
    mcp: command("serve the MCP server over stdio", {
      handler: (_opts, _args) => {
        startMcp();
      },
    }),
  },
});
if (code !== 0) process.exitCode = code;
