/// <reference path="./shims.d.ts" />
// Spike: `atento mcp` over stdio, native.
import { Server, tool, parseBody } from "@chttp/mcp";
import * as v from "@chttp/val";
import * as readline from "node:readline";
import { str, num } from "./lib.ts";
import { doTriage, doRestore, doSweepPlan, doApplySweep, planJson, metricsJson, loginPendingJson, limitsStatusJson, collectionReadText, COLLECTION_FIELD_NAMES, TRIAGE_ACTIONS } from "./ops.ts";
import { ListOpts, listRows, projectJson, filterMatches, getRow, overviewMcpJson, pipelineJson, collectionsSummaryJson } from "./atento.ts";

// InferOutput<object> degrades optional array fields (chttp#110), so coerce by hand.
function fieldsOf(x: unknown): string[] {
  return Array.isArray(x) ? (x as string[]) : [];
}

// Same enum the Node MCP server validates fields against.
const LINK_FIELDS = [
  "id", "url", "urlHash", "title", "source", "addedAt", "note", "tags", "extracted_content", "extractedAt",
  "enrichment", "expiresAt", "expiryReason", "status", "category", "priority", "action", "confidence",
  "readMinutes", "needsBrowser", "createdAt", "updatedAt",
];
const posInt = (): v.VSchema => v.pipe(v.number(), v.integer(), v.minValue(1));

function idsOf(x: unknown): number[] {
  return Array.isArray(x) ? (x as number[]) : [];
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
      status: v.optional(v.picklist(["inbox", "scheduled", "archived", "discarded"])),
      category: v.optional(v.string()),
      stale: v.optional(v.boolean()),
      fields: v.optional(v.array(v.picklist(LINK_FIELDS))),
      filter: v.optional(v.string()),
      limit: v.optional(posInt()),
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

  tool(server, "links_get", v.object({ id: posInt(), fields: v.optional(v.array(v.picklist(LINK_FIELDS))) }), async (input) => {
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

  tool(
    server,
    "links_triage",
    v.object({ ids: v.pipe(v.array(posInt()), v.minLength(1)), action: v.picklist(TRIAGE_ACTIONS) }),
    async (input) => JSON.stringify(await doTriage(idsOf(input.ids), str(input.action) ?? "")),
  );

  tool(server, "links_restore", v.object({ ids: v.pipe(v.array(posInt()), v.minLength(1)) }), async (input) =>
    JSON.stringify(await doRestore(idsOf(input.ids))),
  );

  tool(server, "links_sweep", v.object({ apply: v.optional(v.boolean()) }), async (input) => {
    const plan = await doSweepPlan();
    const archived = input.apply === true ? await doApplySweep(plan) : 0;
    return '{"plan":' + planJson(plan) + ',"archived":' + archived + "}";
  });

  tool(server, "metrics_get", v.object({ range: v.optional(v.string()), now: v.optional(v.string()) }), async (input) =>
    metricsJson(str(input.range) ?? "7d"),
  );

  tool(server, "login_pending", v.object({}), async () => loginPendingJson());

  tool(server, "limits_status", v.object({}), async () => limitsStatusJson());

  tool(
    server,
    "collection_read",
    v.object({
      name: v.picklist(["enriched", "pending", "needs_login", "blocked", "errored", "review", "triaged"]),
      since: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      fields: v.optional(v.array(v.picklist(COLLECTION_FIELD_NAMES))),
      format: v.optional(v.picklist(["json", "tsv"])),
      limit: v.optional(posInt()),
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    async (input) =>
      collectionReadText(str(input.name) ?? "", {
        ...(input.since !== undefined ? { since: num(input.since) ?? 0 } : {}),
        ...(input.fields !== undefined ? { fields: fieldsOf(input.fields) } : {}),
        ...(input.format !== undefined ? { format: str(input.format) ?? "json" } : {}),
        ...(input.limit !== undefined ? { limit: num(input.limit) ?? 0 } : {}),
        ...(input.offset !== undefined ? { offset: num(input.offset) ?? 0 } : {}),
      }),
  );

  // Not yet ported to the native build: writes, ingest, extract and enrich need the FSM,
  // the network and the LLM layer (see .agents/docs/scriptc-native.md).
  const unported = [
    "collection_export",
    "browse_read", "browse_hosts", "ingest_run", "ingest_file", "ingest_text", "ingest_urls",
    "ingest_remote", "ingest_status", "extract_run", "enrich_run",
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
