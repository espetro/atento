/// <reference path="./shims.d.ts" />
// Spike: CLI parsing with @cutils/cli for list, show, mcp (+ overview).
import { bool, command, int, run, str } from "@cutils/cli";
import { getDb, SHOW_COLS, showJson, listJson, overviewJson } from "./lib.ts";
import { startMcp } from "./mcpserver.ts";

const code = run({
  name: "atento",
  version: "0.1.0",
  description: "CLI/MCP-first link triage pipeline (native spike)",
  commands: {
    list: command("list links", {
      options: {
        status: str({ description: "filter by status" }),
        limit: int({ default: 1000000, description: "cap the number of rows" }),
        json: bool({ description: "print json" }),
      },
      handler: (opts, _args) => {
        const status = opts.status === "" ? null : opts.status;
        const arr = listJson(status, opts.limit);
        if (opts.json) {
          console.log(JSON.stringify(JSON.parse(arr), null, 2));
        } else {
          const rows = JSON.parse(arr) as { id: number; status: string; url: string }[];
          console.log("id  status  url");
          for (const r of rows) console.log(r.id + "  " + r.status + "  " + r.url);
          console.log("\n" + rows.length + " links");
        }
      },
    }),
    show: command("show one link in full", {
      args: ["id"],
      options: { json: bool({ description: "print json" }) },
      handler: (opts, args) => {
        const st = getDb().prepareRaw("SELECT " + SHOW_COLS + " FROM links WHERE id = ?");
        const r = st.getRaw([Number(args[0])]);
        st.finalize();
        if (r === undefined || r === null) {
          console.error("error: link " + args[0] + " not found");
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(JSON.parse(showJson(r)), null, 2));
      },
    }),
    overview: command("overview of every link by pipeline state", {
      options: { json: bool({ description: "print json" }) },
      handler: (_opts, _args) => {
        console.log(JSON.stringify(JSON.parse(overviewJson()), null, 2));
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
