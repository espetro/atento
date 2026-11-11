/// <reference path="./shims.d.ts" />
// Spike: `atento mcp` over stdio, native.
import { Server, tool, parseBody } from "@chttp/mcp";
import * as v from "@chttp/val";
import * as readline from "node:readline";
import { str, num } from "./lib.ts";
import { ListOpts, listRows, projectJson, filterMatches, getRow, overviewMcpJson, pipelineJson, collectionsSummaryJson } from "./atento.ts";

// InferOutput<object> degrades optional array fields (chttp#110), so coerce by hand.
function fieldsOf(x: unknown): string[] {
  return Array.isArray(x) ? (x as string[]) : [];
}

export function startMcp(): void {
  const server = new Server({
    name: "atento",
    version: "0.1.0",
    emitJsonSchema: (s) => v.toJsonSchema(s),
  });

  tool(
    server,
    "links_list",
    v.object({
      q: v.optional(v.string()),
      status: v.optional(v.string()),
      category: v.optional(v.string()),
      stale: v.optional(v.boolean()),
      fields: v.optional(v.array(v.string())),
      filter: v.optional(v.string()),
      limit: v.optional(v.number()),
    }),
    async (input) => {
      const o = new ListOpts();
      o.q = str(input.q);
      o.status = str(input.status);
      o.category = str(input.category);
      o.stale = input.stale === true;
      o.limit = num(input.limit) ?? -1;
      const filter = str(input.filter);
      const fields = fieldsOf(input.fields);
      const parts: string[] = [];
      for (const r of listRows(o)) {
        const proj = projectJson(r, fields);
        if (filter !== null && filter !== "" && !filterMatches(JSON.parse(proj), filter)) continue;
        parts.push(proj);
      }
      return '{"links":[' + parts.join(",") + "]}";
    },
  );

  tool(server, "links_get", v.object({ id: v.number(), fields: v.optional(v.array(v.string())) }), async (input) => {
    const r = getRow(num(input.id) ?? -1);
    if (r === null) return '{"link":null}';
    return '{"link":' + projectJson(r, fieldsOf(input.fields)) + "}";
  });

  tool(server, "links_overview", v.object({ topHosts: v.optional(v.number()) }), async (input) => overviewMcpJson(num(input.topHosts) ?? 50));

  tool(
    server,
    "links_pipeline",
    v.object({
      state: v.optional(v.string()),
      host: v.optional(v.string()),
      q: v.optional(v.string()),
      limit: v.optional(v.number()),
      offset: v.optional(v.number()),
    }),
    async (input) =>
      '{"links":' + pipelineJson(str(input.state), str(input.host), str(input.q), num(input.limit) ?? -1, num(input.offset) ?? 0) + "}",
  );

  tool(server, "collections_summary", v.object({}), async () => collectionsSummaryJson());

  // Not yet ported to the native build: writes, ingest, extract and enrich need the FSM,
  // the network and the LLM layer (see .agents/docs/scriptc-native.md).
  const unported = [
    "links_triage", "links_restore", "links_sweep", "collection_read", "collection_export",
    "browse_read", "browse_hosts", "ingest_run", "ingest_file", "ingest_text", "ingest_urls",
    "ingest_remote", "ingest_status", "extract_run", "enrich_run", "metrics_get", "limits_status",
    "login_pending",
  ];
  for (const name of unported) {
    tool(server, name, v.object({}), async () => {
      throw new Error(name + " is not available in the native build yet");
    });
  }

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
