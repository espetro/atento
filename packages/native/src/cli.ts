/// <reference path="./shims.d.ts" />
// Native atento CLI over the real schema.
import { bool, command, int, runAsync, str } from "@cutils/cli";
import * as readline from "node:readline";
import { startMcp } from "./mcpserver.ts";
import {
  doTriage, doRestore, doSweepPlan, doApplySweep, metricsJson, closeStore, TRIAGE_ACTIONS,
  ingestTextJson, ingestUrlsJson, ingestFileJson, ingestRemoteJson, ingestStatusJson,
  collectionReadText, collectionExportCli,
  importFiles, enrichRunCli, enrichUntilEmptyRun, prunePlanNative, applyPruneNative, doBackup, defaultBackupPath,
  guardStatusRows, breakerResetNative,
} from "./ops.ts";
import { renderSweepPlan, renderMetrics, renderPrunePlan, renderStatus, formatTotals, formatBatchSummary } from "./render.ts";
import {
  ListOpts, listRows, projectJson, filterMatches, splitFields, getRow, overviewCliJson, formatOverview, renderTable,
  shortDate, cell, stateCols, historyEntries, SHOW_FIELDS, STATE_LIST_FIELDS, STATES, collectionsSummaryJson, COLLECTIONS,
} from "./atento.ts";

const STATUSES = ["inbox", "scheduled", "archived", "discarded"];

function fail(msg: string): void {
  console.error("error: " + msg);
  process.exitCode = 1;
}

// ------------------------------------------------------------------ helpers

interface IngestSummary {
  jobId: string;
  accepted: number;
  duplicates: number;
  rejected: number;
  status: string;
  warnings?: string[];
  busy?: { runId: number; stage: string; pid?: number | null };
}

/** printSummary from packages/cli/src/commands/ingest.ts. */
function printIngestSummary(json: string): void {
  const s = JSON.parse(json) as IngestSummary;
  const warnings = s.warnings === undefined ? [] : s.warnings;
  for (const w of warnings) console.log("warning: " + w);
  if (s.busy !== undefined) {
    console.log("busy: ingest is held by run " + s.busy.runId + " (" + s.busy.stage + "); try again later");
    process.exitCode = 3;
    return;
  }
  console.log(
    "job " + s.jobId + ": " + s.accepted + " accepted" +
      (s.duplicates > 0 ? ", " + s.duplicates + " duplicates" : "") +
      (s.rejected > 0 ? ", " + s.rejected + " rejected" : "") +
      " (" + s.status + ")",
  );
}

/** reportBusy from packages/cli/src/commands/pipeline.ts. */
function reportBusy(busy: { runId: number; pid: number | null } | null, stage: string): void {
  if (busy === null) return;
  console.log(
    "busy: " + stage + " is held by run " + busy.runId +
      (busy.pid !== null ? " (pid " + busy.pid + ")" : "") +
      "; try again later",
  );
  process.exitCode = 3;
}

function stub(name: string): { handler: () => void } {
  return {
    handler: () => {
      fail(name + " is not available in the native build yet");
    },
  };
}

function promptYesNo(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
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
    import: command("import links from files (markdown, json, url list, safari reading list)", {
      args: [{ name: "files", variadic: true }],
      options: { limit: int({ default: -1, description: "cap the number of links ingested" }) },
      handler: async (opts, args) => {
        const out = await importFiles(args[0], opts.limit > 0 ? opts.limit : null);
        if (out.busy !== null) {
          reportBusy(out.busy, "ingest");
          await closeStore();
          return;
        }
        for (const f of out.files) console.log(f.file + ": " + f.count + " links via " + f.importer);
        console.log("ingest: " + out.okCount + "/" + out.inputCount + " ok");
        if (out.duplicates > 0) console.log("(" + out.duplicates + " already known, no-op)");
        await closeStore();
      },
    }),
    enrich: command("run enrichment (one structured-output call per link)", {
      options: {
        limit: int({ default: -1, description: "cap the number of links processed" }),
        "until-empty": bool({ description: "repeat batches until no enrichable link remains or no batch makes progress" }),
      },
      handler: async (opts, _args) => {
        if (opts.untilEmpty) {
          const outcome = await enrichUntilEmptyRun(opts.limit > 0 ? opts.limit : null);
          for (const b of outcome.batches) console.log(formatBatchSummary(b));
          if (outcome.busy !== undefined) {
            reportBusy({ runId: outcome.busy.runId, pid: outcome.busy.pid }, "enrich");
            await closeStore();
            return;
          }
          console.log(formatTotals(outcome));
          if (outcome.hitCap) {
            console.log("(stopped at the 100-batch cap with links still queued; re-run to continue)");
          }
          await closeStore();
          return;
        }
        const outcome = await enrichRunCli(opts.limit > 0 ? opts.limit : null);
        if (outcome.busy !== undefined) {
          reportBusy({ runId: outcome.busy.runId, pid: outcome.busy.pid }, "enrich");
          await closeStore();
          return;
        }
        console.log("enrich: " + outcome.okCount + "/" + outcome.inputCount + " ok" +
          (outcome.errorCount > 0 ? ", " + outcome.errorCount + " errors" : ""));
        if (outcome.deferredCount > 0) {
          console.log("(" + outcome.deferredCount + " deferred; retry in " + Math.round(outcome.retryAfter / 1000) + "s)");
        }
        await closeStore();
      },
    }),
    prune: command("hard-delete links past delete_after_days (asks for confirmation)", {
      options: {
        apply: bool({ description: "run the delete (a confirmation prompt follows)" }),
        yes: bool({ description: "skip the confirmation prompt" }),
      },
      handler: async (opts, _args) => {
        const plan = await prunePlanNative();
        if (plan.totals.delete === 0) {
          console.log("nothing to prune");
          await closeStore();
          return;
        }
        console.log(renderPrunePlan(plan));
        if (!opts.apply) {
          console.log("\n" + plan.totals.delete + " item(s) would be deleted (dry-run; use --apply)");
          await closeStore();
          return;
        }
        const confirmed = opts.yes ? "y" : await promptYesNo("delete " + plan.totals.delete + " link(s) permanently? this cannot be undone [y/N] ");
        if (confirmed.trim().toLowerCase() !== "y") {
          console.log("aborted");
          await closeStore();
          return;
        }
        const deleted = await applyPruneNative(plan);
        console.log("deleted " + deleted + " link(s)");
        await closeStore();
      },
    }),
    backup: command("write a consistent sqlite backup of the database", {
      options: { out: str({ description: "destination file (default <config dir>/backups/atento-<timestamp>.db)" }) },
      handler: async (opts, _args) => {
        const dest = opts.out !== "" ? opts.out : defaultBackupPath();
        await doBackup(dest);
        console.log("backup written to " + dest);
        await closeStore();
      },
    }),
    status: command("per-host rate limit budget, circuit breaker state and reopen time", {
      options: { json: bool({ description: "emit JSON" }) },
      handler: async (opts, _args) => {
        const rows = await guardStatusRows();
        if (opts.json) console.log(JSON.stringify(rows, null, 2));
        else for (const line of renderStatus(rows)) console.log(line);
        await closeStore();
      },
    }),
    breaker: command("circuit breaker controls", {
      commands: {
        reset: command("force-close the breaker for a host (or \"llm\")", {
          args: ["host"],
          handler: async (_opts, args) => {
            const key = await breakerResetNative(args[0]);
            console.log("breaker for " + key + ": closed (cooldown level reset)");
            await closeStore();
          },
        }),
      },
    }),
    ingest: command("bulk-ingest links (file, text, urls, remote) through the durable spool", {
      commands: {
        file: command("ingest links from a local file (md, json, txt, plist)", {
          args: ["path"],
          handler: async (_opts, args) => {
            printIngestSummary(await ingestFileJson(args[0]));
            await closeStore();
          },
        }),
        text: command("ingest links found in long-form text (markdown links and bare urls)", {
          args: ["text"],
          handler: async (_opts, args) => {
            printIngestSummary(await ingestTextJson(args[0]));
            await closeStore();
          },
        }),
        urls: command("ingest an explicit url array (max 500 per call)", {
          args: [{ name: "urls", variadic: true }],
          options: {
            note: str({ description: "note attached to every link" }),
            tags: str({ description: "comma-separated tags attached to every link" }),
          },
          handler: async (opts, args) => {
            const input: { urls: string[]; note?: string; tags?: string[] } = { urls: args[0] };
            if (opts.note !== "") input.note = opts.note;
            if (opts.tags !== "") {
              input.tags = opts.tags.split(",").map((t: string) => t.trim()).filter((t: string) => t !== "");
            }
            printIngestSummary(await ingestUrlsJson(input));
            await closeStore();
          },
        }),
        remote: command("ingest links from a remote file (gist or raw url)", {
          args: ["url"],
          handler: async (_opts, args) => {
            printIngestSummary(await ingestRemoteJson(args[0]));
            await closeStore();
          },
        }),
        status: command("show progress of an ingest job", {
          args: ["jobId"],
          handler: async (_opts, args) => {
            const parsed = JSON.parse(await ingestStatusJson(args[0])) as { job: { jobId: string; status: string; done: number; total: number; error: string | null } | null };
            const job = parsed.job;
            if (job === null) {
              console.log("job " + args[0] + ": not found");
              process.exitCode = 1;
            } else {
              console.log("job " + job.jobId + ": " + job.status + " " + job.done + "/" + job.total + (job.error !== null ? " — " + job.error : ""));
            }
            await closeStore();
          },
        }),
      },
    }),
    collections: command("token-efficient pipeline views: summary, reads with cursors, exports", {
      commands: {
        summary: command("counts per collection plus the hosts that need a login", {
          handler: async () => {
            const s = JSON.parse(collectionsSummaryJson()) as {
              total: number;
              collections: { [k: string]: number };
              needsLoginHosts: { host: string; count: number }[];
            };
            for (const name of COLLECTIONS) console.log(name + ": " + s.collections[name]);
            console.log("total: " + s.total);
            for (const h of s.needsLoginHosts) console.log("needs_login " + h.host + ": " + h.count);
            await closeStore();
          },
        }),
        read: command("read one collection (paginated, fields projection, --since cursor)", {
          args: ["name"],
          options: {
            since: int({ default: -1, description: "only links changed after this link_events cursor" }),
            fields: str({ description: "comma-separated field projection" }),
            format: str({ default: "json", description: "json or tsv" }),
            limit: int({ default: -1, description: "rows per page (max 200)" }),
            offset: int({ default: -1, description: "row offset" }),
          },
          handler: async (opts, args) => {
            const name = args[0];
            if (COLLECTIONS.indexOf(name) < 0) {
              fail('unknown collection "' + name + '"; expected one of: ' + COLLECTIONS.join(", "));
              await closeStore();
              return;
            }
            const fields = opts.fields === "" ? undefined : opts.fields.split(",").map((f: string) => f.trim()).filter((f: string) => f !== "");
            const ro: { since?: number; fields?: string[]; format?: string; limit?: number; offset?: number } = { format: opts.format };
            if (opts.since > 0) ro.since = opts.since;
            if (fields !== undefined) ro.fields = fields;
            if (opts.limit > 0) ro.limit = opts.limit;
            if (opts.offset >= 0) ro.offset = opts.offset;
            const text = await collectionReadText(name, ro);
            if (opts.format === "tsv") {
              process.stdout.write(text);
            } else if (opts.format === "json") {
              console.log(JSON.stringify(JSON.parse(text), null, 2));
            } else {
              fail('unknown format "' + opts.format + '"; expected json or tsv');
            }
            await closeStore();
          },
        }),
        export: command("write one collection to ~/.atento/exports/ and print the handle", {
          args: ["name"],
          options: {
            since: int({ default: -1, description: "only links changed after this cursor" }),
            fields: str({ description: "comma-separated field projection" }),
            format: str({ default: "jsonl", description: "jsonl, md or tsv" }),
          },
          handler: async (opts, args) => {
            const name = args[0];
            const format = opts.format;
            if (format !== "jsonl" && format !== "md" && format !== "tsv") {
              fail("format must be jsonl, md or tsv");
              await closeStore();
              return;
            }
            if (COLLECTIONS.indexOf(name) < 0) {
              fail('unknown collection "' + name + '"; expected one of: ' + COLLECTIONS.join(", "));
              await closeStore();
              return;
            }
            const fields = opts.fields === "" ? undefined : opts.fields.split(",").map((f: string) => f.trim()).filter((f: string) => f !== "");
            const eo: { since?: number; fields?: string[]; format?: string } = { format: format };
            if (opts.since > 0) eo.since = opts.since;
            if (fields !== undefined) eo.fields = fields;
            const r = JSON.parse(await collectionExportCli(name, eo)) as { count: number; bytes: number; path: string; uri: string };
            console.log(r.count + " rows, " + r.bytes + " bytes");
            console.log(r.path);
            console.log(r.uri);
            await closeStore();
          },
        }),
      },
    }),
    extract: command("extract content for inbox links that lack it", stub("extract")),
    run: command("ingest+extract+enrich in one pass (idempotent)", stub("run")),
    retry: command("re-trigger headless extraction for a captured link (explicit, never automatic)", stub("retry")),
    eval: command("run the golden-set evals", stub("eval")),
    serve: command("serve the web ui (requires @atento/server)", stub("serve")),
    login: command("log in to a host through a real browser profile", stub("login")),
    requeue: command("requeue parked links for another extraction attempt", stub("requeue")),
    browse: command("read one page through a saved browser profile", stub("browse")),
    browsers: command("browser adapter configuration", stub("browsers")),
    media: command("media (video/audio) processing", stub("media")),
    mcp: command("serve the MCP server over stdio", {
      handler: (_opts, _args) => {
        startMcp();
      },
    }),
  },
});
if (code !== 0) process.exitCode = code;
