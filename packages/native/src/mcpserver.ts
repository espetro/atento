/// <reference path="./shims.d.ts" />
// Spike: `atento mcp` over stdio, native.
import { Server, tool, parseBody } from "@chttp/mcp";
import * as v from "@chttp/val";
import * as readline from "node:readline";
import { getDb, str, num, COLS, toLink, linkJson, counts, listJson, overviewJson } from "./lib.ts";

export function startMcp(): void {
  const server = new Server({
    name: "atento",
    version: "0.1.0",
    emitJsonSchema: (s) => v.toJsonSchema(s),
  });

  tool(
    server,
    "links_list",
    v.object({ status: v.optional(v.string()), limit: v.optional(v.number()) }),
    async (input) => '{"links":' + listJson(str(input.status), num(input.limit) ?? 1000000) + "}",
  );

  tool(server, "links_get", v.object({ id: v.number() }), async (input) => {
    const st = getDb().prepareRaw("SELECT " + COLS + " FROM links WHERE id = ?");
    const r = st.getRaw([num(input.id) ?? -1]);
    st.finalize();
    if (r === undefined || r === null) throw new Error("link " + String(input.id) + " not found");
    return linkJson(toLink(r));
  });

  tool(server, "links_overview", v.object({}), async () => overviewJson());

  tool(server, "collections_summary", v.object({}), async () => {
    const rows = counts();
    let pending = 0, triaged = 0, errored = 0, blocked = 0, enriched = 0, total = 0;
    for (const r of rows) {
      if (r.k === "created" || r.k === "extracting" || r.k === "extracted" || r.k === "enriching") pending += r.n;
      else if (r.k === "scheduled" || r.k === "archived" || r.k === "discarded") triaged += r.n;
      else if (r.k === "errored") errored += r.n;
      else if (r.k === "needs_browser" || r.k === "deferred") blocked += r.n; // spike: ignores park-reason class
      else if (r.k === "inbox") enriched += r.n; // spike: ignores the enrichment-null => pending rule
      if (r.k !== "deleted") total += r.n;
    }
    return (
      '{"total":' + total + ',"collections":{"pending":' + pending + ',"enriched":' + enriched +
      ',"needs_login":0,"blocked":' + blocked + ',"review":0,"errored":' + errored + ',"triaged":' + triaged +
      '},"needsLoginHosts":[]}'
    );
  });

  // stdio glue: line-delimited JSON-RPC (readline works; process.stdin.on("data") is SC0001).
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line: string) => {
    if (line.trim() === "") return;
    try {
      const req = parseBody(line);
      const res = await server.handleRequest(req);
      if (res !== null) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (e) {
      const m = e instanceof Error ? e.message : "error";
      process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":' + JSON.stringify(m) + "}}\n");
    }
  });

}
