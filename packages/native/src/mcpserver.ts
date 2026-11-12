/// <reference path="./shims.d.ts" />
// `atento mcp` over stdio, native. Tool schemas are the same zod/mini
// definitions packages/mcp uses, so tools/list and validation errors match
// the Node server byte-for-byte. @chttp/mcp only needs a Standard Schema
// passthrough at registration (real validation runs per call, formatted
// like the MCP SDK's validateStandardSchema).
import { Server, tool, parseBody } from "@chttp/mcp";
import * as v from "@chttp/val";
import * as readline from "node:readline";
import { z } from "zod/mini";
import en from "zod/v4/locales/en.js";
import { TOOL_SCHEMAS } from "./tool-schemas.ts";
import { str, num } from "./lib.ts";
import { doTriage, doRestore, doSweepPlan, doApplySweep, planJson, metricsJson, loginPendingJson, limitsStatusJson, collectionReadText, collectionExportText, COLLECTION_FIELD_NAMES, TRIAGE_ACTIONS, ingestTextJson, ingestUrlsJson, ingestFileJson, ingestStatusJson, ingestRunJson } from "./ops.ts";
import { ListOpts, listRows, projectJson, filterMatches, getRow, overviewMcpJson, pipelineJson, collectionsSummaryJson } from "./atento.ts";

// InferOutput<object> degrades optional array fields (chttp#110), so coerce by hand.
function fieldsOf(x: unknown): string[] {
  return Array.isArray(x) ? (x as string[]) : [];
}

function idsOf(x: unknown): number[] {
  return Array.isArray(x) ? (x as number[]) : [];
}

// Same enums the Node MCP server validates against (packages/mcp/src/tools).
const LINK_FIELDS = [
  "id", "url", "urlHash", "title", "source", "addedAt", "note", "tags", "extracted_content", "extractedAt",
  "enrichment", "expiresAt", "expiryReason", "status", "category", "priority", "action", "confidence",
  "readMinutes", "needsBrowser", "createdAt", "updatedAt",
] as [string, ...string[]];
const STATUSES = ["inbox", "scheduled", "archived", "discarded"] as [string, ...string[]];
const ACTIONS = ["read_now", "schedule", "archive", "discard"] as [string, ...string[]];
const STATES = [
  "created", "extracting", "extracted", "needs_browser", "deferred", "enriching",
  "inbox", "scheduled", "archived", "discarded", "errored", "deleted",
] as [string, ...string[]];
const COLLECTION_NAMES = [
  "enriched", "pending", "needs_login", "blocked", "errored", "review", "triaged",
] as [string, ...string[]];
const COLLECTION_FORMATS_READ = ["json", "tsv"] as [string, ...string[]];
const COLLECTION_FORMATS_EXPORT = ["jsonl", "md", "tsv"] as [string, ...string[]];

const optionalLimit = z.optional(z.number().check(z.int(), z.positive()));
const optionalFields = z.optional(z.array(z.enum(LINK_FIELDS)));
const collectionFieldsSchema = z.optional(z.array(z.enum(COLLECTION_FIELD_NAMES as unknown as [string, ...string[]])));
const collectionNameSchema = z.enum(COLLECTION_NAMES);
const sinceSchema = z.optional(z.number().check(z.int(), z.minimum(0)));

interface StdIssue {
  path?: unknown;
  message?: unknown;
}
interface StdResult {
  value?: unknown;
  issues?: StdIssue[];
}
interface StdSchema {
  "~standard": { validate: (input: unknown) => Promise<StdResult> };
}

// The MCP SDK's formatIssue + validateStandardSchema error text, verbatim.
function formatIssue(issue: StdIssue): string {
  const path = issue.path;
  if (!Array.isArray(path) || path.length === 0) return String(issue.message ?? "");
  const dots = path
    .map((p) => String(p !== null && typeof p === "object" ? (p as { key: unknown }).key : p))
    .join(".");
  return dots + ": " + String(issue.message ?? "");
}

function validationError(name: string, issues: StdIssue[]): { content: { type: string; text: string }[]; isError: boolean } {
  return {
    content: [
      {
        type: "text",
        text: "Input validation error: Invalid arguments for tool " + name + ": " + issues.map(formatIssue).join(", "),
      },
    ],
    isError: true,
  };
}

// Register one tool whose wire schema is the Node zod/mini object. The
// @chttp/mcp slot gets v.unknown() (a hand-built Standard Schema record is
// not representable at the tool() boundary); validation runs in the handler
// so failures take the SDK's isError shape, not a protocol error, and the
// per-tool emitter advertises the precomputed Node inputSchema.
function ztool(
  server: Server,
  name: string,
  description: string,
  schema: StdSchema,
  run: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  tool(
    server,
    name,
    v.unknown(),
    async (input) => {
      const args = (input === null || input === undefined ? {} : input) as Record<string, unknown>;
      // zod/mini's ~standard.validate is synchronous; the Standard Schema
      // types claim a Promise. Route the function value through `unknown`
      // first: a direct cast keeps the erased Promise signature and the
      // runtime then rejects zod's plain-object result.
      const stdUnknown: unknown = schema["~standard"];
      const validateUnknown: unknown = (stdUnknown as Record<string, unknown>)["validate"];
      const validate = validateUnknown as (value: unknown) => StdResult;
      const parsed = validate(args);
      const issues = parsed.issues;
      if (issues !== undefined && issues !== null && issues.length > 0) {
        return validationError(name, issues);
      }
      const value = parsed.value;
      return run((value === undefined || value === null ? {} : value) as Record<string, unknown>);
    },
    { description: description, emit: () => TOOL_SCHEMAS[name] as Record<string, unknown> },
  );
}

export function startMcp(): void {
  // The Node server gets rich zod messages because @modelcontextprotocol/server
  // pulls in classic zod, whose first ZodType registers the en locale. Do the
  // same explicitly so validation text matches byte-for-byte.
  z.config(en());
  const server = new Server({
    name: "atento",
    version: "0.1.0",
    emitJsonSchema: () => ({ type: "object" }),
  });

  ztool(
    server,
    "links_list",
    "List links (spec name links.list). Compact projection by default: " +
      "extracted_content is included only when fields asks for it. " +
      "filter uses the CLI batch syntax, e.g. \"status:inbox category:job\".",
    z.object({
      q: z.optional(z.string()),
      status: z.optional(z.enum(STATUSES)),
      category: z.optional(z.string()),
      stale: z.optional(z.boolean()),
      fields: optionalFields,
      filter: z.optional(z.string()),
      limit: optionalLimit,
    }) as unknown as StdSchema,
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

  ztool(
    server,
    "links_overview",
    "Pipeline overview (spec name links.overview): how many links sit in " +
      "each pipeline state, how many parked links carry each park reason " +
      "(login_wall, bot_block, js_shell, http_error, timeout, review_only, " +
      "unknown), plus the busiest hosts with their per-state and per-reason " +
      "breakdown. Read-only: it never mutates state. Use it to see where " +
      "the whole corpus stands without listing every link.",
    z.object({ topHosts: optionalLimit }) as unknown as StdSchema,
    async (input) => overviewMcpJson(num(input.topHosts) ?? 50),
  );

  ztool(
    server,
    "links_pipeline",
    "Pipeline rows (spec name links.pipeline): every link with its FSM " +
      "state, the reason it carries and its next retry time. Filters: " +
      "state, host, q. Unlike links_list this spans all states, not just " +
      "the inbox projection.",
    z.object({
      state: z.optional(z.enum(STATES)),
      host: z.optional(z.string()),
      q: z.optional(z.string()),
      limit: optionalLimit,
      offset: z.optional(z.number().check(z.int(), z.minimum(0))),
    }) as unknown as StdSchema,
    async (input) =>
      '{"links":' + pipelineJson(str(input.state), str(input.host), str(input.q), num(input.limit) ?? -1, num(input.offset) ?? 0) + "}",
  );

  ztool(
    server,
    "links_get",
    "Get one link by id (spec name links.get). Extracted content only when fields includes it.",
    z.object({ id: z.number().check(z.int(), z.positive()), fields: optionalFields }) as unknown as StdSchema,
    async (input) => {
      const r = getRow(num(input.id) ?? -1);
      if (r === null) return '{"link":null}';
      return '{"link":' + projectJson(r, fieldsOf(input.fields)) + "}";
    },
  );

  ztool(
    server,
    "links_triage",
    "Aggregate triage tool (spec name links.triage): apply one action to many ids. " +
      "Actions: read_now, schedule, archive, discard.",
    z.object({
      ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
      action: z.enum(ACTIONS),
    }) as unknown as StdSchema,
    async (input) => JSON.stringify(await doTriage(idsOf(input.ids), str(input.action) ?? "")),
  );

  ztool(
    server,
    "links_restore",
    "Restore parked links (archived, discarded, errored) back to the inbox. " +
      "Deleted links are tombstones and are reported as blocked, never resurrected.",
    z.object({
      ids: z.array(z.number().check(z.int(), z.positive())).check(z.minLength(1)),
    }) as unknown as StdSchema,
    async (input) => JSON.stringify(await doRestore(idsOf(input.ids))),
  );

  ztool(
    server,
    "links_sweep",
    "Sweep stale links (spec name links.sweep). Dry-run by default; apply archives. Never deletes.",
    z.object({ apply: z.optional(z.boolean()) }) as unknown as StdSchema,
    async (input) => {
      const plan = await doSweepPlan();
      const archived = input.apply === true ? await doApplySweep(plan) : 0;
      return '{"plan":' + planJson(plan) + ',"archived":' + archived + "}";
    },
  );

  ztool(
    server,
    "ingest_run",
    "Ingest links from files (spec name ingest.run). Same importers as the CLI import command.",
    z.object({
      files: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
      limit: optionalLimit,
    }) as unknown as StdSchema,
    async (input) =>
      ingestRunJson(
        Array.isArray(input.files) ? (input.files as string[]) : [],
        num(input.limit),
      ),
  );

  ztool(
    server,
    "ingest_file",
    "Bulk-ingest links from a local file (spec name ingest.file): markdown, " +
      "json, url list (.txt), Safari reading list (.plist) or html bookmarks. " +
      "Costs zero tokens for the payload — the preferred ingest when the " +
      "agent runs on the same machine as the atento store. Returns only " +
      "the job summary { jobId, accepted, duplicates, rejected, status }, " +
      "never the links themselves.",
    z.object({ path: z.string().check(z.minLength(1)) }) as unknown as StdSchema,
    async (input) => ingestFileJson(str(input.path) ?? ""),
  );

  ztool(
    server,
    "ingest_text",
    "Bulk-ingest links found in long-form text (spec name ingest.text): " +
      "notes, chat dumps, pasted pages. URLs are pulled out with the " +
      "markdown and url-list importers. Returns only the job summary.",
    z.object({ text: z.string().check(z.minLength(1)) }) as unknown as StdSchema,
    async (input) => ingestTextJson(str(input.text) ?? ""),
  );

  ztool(
    server,
    "ingest_urls",
    "Bulk-ingest an explicit URL array (spec name ingest.urls), capped at " +
      "500 urls per call — larger lists belong in a file via ingest_file. " +
      "Optional note and tags are attached to every link. Returns only the " +
      "job summary.",
    z.object({
      urls: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(500)),
      note: z.optional(z.string()),
      tags: z.optional(z.array(z.string())),
    }) as unknown as StdSchema,
    async (input) => {
      return ingestUrlsJson({
        urls: Array.isArray(input.urls) ? (input.urls as string[]) : [],
        ...(input.note !== undefined ? { note: str(input.note) ?? "" } : {}),
        ...(input.tags !== undefined ? { tags: Array.isArray(input.tags) ? (input.tags as string[]) : [] } : {}),
      });
    },
  );

  ztool(
    server,
    "ingest_remote",
    "Bulk-ingest links from a remote file (spec name ingest.remote): a " +
      "gist or raw URL is fetched, then parsed with the importer its " +
      "extension selects (json, markdown, url list, plist). Returns only " +
      "the job summary.",
    z.object({ url: z.url() }) as unknown as StdSchema,
    async () => {
      throw new Error("ingest_remote is not available in the native build yet");
    },
  );

  ztool(
    server,
    "ingest_status",
    "Progress of one ingest job (spec name ingest.status): status, " +
      "total/done/cursor and the last error. Use it for large jobs; small " +
      "jobs are already done when ingest_* returns.",
    z.object({ jobId: z.string().check(z.minLength(1)) }) as unknown as StdSchema,
    async (input) => ingestStatusJson(str(input.jobId) ?? ""),
  );

  ztool(
    server,
    "extract_run",
    "Run extraction on inbox links lacking content (spec name extract.run).",
    z.object({ limit: optionalLimit }) as unknown as StdSchema,
    async () => {
      throw new Error("extract_run is not available in the native build yet");
    },
  );

  ztool(
    server,
    "enrich_run",
    "Run enrichment (spec name enrich.run). Model identity comes from env config; nothing here names a provider.",
    z.object({ limit: optionalLimit }) as unknown as StdSchema,
    async () => {
      throw new Error("enrich_run is not available in the native build yet");
    },
  );

  ztool(
    server,
    "metrics_get",
    "Per-stage metrics summary (spec name metrics.get), range like 24h, 7d, 2w.",
    z.object({ range: z.optional(z.string()), now: z.optional(z.iso.datetime()) }) as unknown as StdSchema,
    async (input) => metricsJson(str(input.range) ?? "7d"),
  );

  ztool(
    server,
    "limits_status",
    "Rate limit budget and circuit breaker state per host (spec name limits.status). " +
      "Read-only: it never mutates state. Breaker reset stays CLI-only.",
    z.object({}) as unknown as StdSchema,
    async () => limitsStatusJson(),
  );

  ztool(
    server,
    "login_pending",
    "Hosts that still need a browser login (spec name login.pending). " +
      "Read-only: pending hosts with their waiting link counts, and the " +
      "hosts that already have a saved profile with its age. The browser " +
      "login itself is a CLI step (atento login): it needs a terminal.",
    z.object({}) as unknown as StdSchema,
    async () => loginPendingJson(),
  );

  ztool(
    server,
    "collections_summary",
    "Counts per pipeline collection plus the per-host breakdown of " +
      "needs_login (spec name collections.summary). This is the tool a " +
      "harness calls after a run: one line per host that still needs a " +
      "login. Read-only.",
    z.object({}) as unknown as StdSchema,
    async () => collectionsSummaryJson(),
  );

  ztool(
    server,
    "collection_read",
    "Read one collection inline (spec name collections.read): paginated " +
      "(<=50 rows by default), fields projection, format=json|tsv. Pass " +
      "since=<cursor> from a previous read or export to get only the " +
      "delta; the JSON response carries `cursor`, and TSV ends with a " +
      "`# cursor: <n>` trailer line — store it for the next read. " +
      "Collections: " +
      COLLECTION_NAMES.join(", ") + ".",
    z.object({
      name: collectionNameSchema,
      since: sinceSchema,
      fields: collectionFieldsSchema,
      format: z.optional(z.enum(COLLECTION_FORMATS_READ)),
      limit: optionalLimit,
      offset: z.optional(z.number().check(z.int(), z.minimum(0))),
    }) as unknown as StdSchema,
    async (input) =>
      collectionReadText(str(input.name) ?? "", {
        ...(input.since !== undefined ? { since: num(input.since) ?? 0 } : {}),
        ...(input.fields !== undefined ? { fields: fieldsOf(input.fields) } : {}),
        ...(input.format !== undefined ? { format: str(input.format) ?? "json" } : {}),
        ...(input.limit !== undefined ? { limit: num(input.limit) ?? 0 } : {}),
        ...(input.offset !== undefined ? { offset: num(input.offset) ?? 0 } : {}),
      }),
  );

  ztool(
    server,
    "collection_export",
    "Export one collection to a file (spec name collections.export): " +
      "writes ~/.atento/exports/<name>-<cursor>.<ext> and returns " +
      "{ path, uri, count, bytes } where uri is a atento:// resource " +
      "link to read lazily. Use it instead of collection_read for large " +
      "result sets.",
    z.object({
      name: collectionNameSchema,
      since: sinceSchema,
      fields: collectionFieldsSchema,
      format: z.optional(z.enum(COLLECTION_FORMATS_EXPORT)),
    }) as unknown as StdSchema,
    async (input) =>
      collectionExportText(str(input.name) ?? "", {
        ...(input.since !== undefined ? { since: num(input.since) ?? 0 } : {}),
        ...(input.fields !== undefined ? { fields: fieldsOf(input.fields) } : {}),
        ...(input.format !== undefined ? { format: str(input.format) ?? "jsonl" } : {}),
      }),
  );

  ztool(
    server,
    "browse_read",
    "Read one page through the saved browser profile of its host and " +
      "return markdown (spec name browse.read). READ-ONLY: no clicks, no " +
      "typing, no forms. Only the hosts the owner listed in the [share] " +
      "hosts config may be read (the list ships empty, so by default every " +
      "call is refused), and only through a profile saved by `atento " +
      "login`. The read spends the same per-host budget as the pipeline: " +
      "human pacing, a daily cap, working hours and the circuit breaker. " +
      "Nothing is written to the link store.",
    z.object({ url: z.url() }) as unknown as StdSchema,
    async () => {
      throw new Error("browse_read is not available in the native build yet");
    },
  );

  ztool(
    server,
    "browse_hosts",
    "Which hosts may be read through a saved browser profile (spec name " +
      "browse.hosts). Read-only: the saved profiles with their verdict " +
      "from the [share] hosts allowlist. A host that is not shared can be " +
      "made shareable by the owner in the config; nothing is shared by " +
      "default.",
    z.object({}) as unknown as StdSchema,
    async () => {
      throw new Error("browse_hosts is not available in the native build yet");
    },
  );

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
