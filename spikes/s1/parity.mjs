// S1 parity check: run identical Store ops against the production
// SqliteStore (drizzle + better-sqlite3) and the spike CutilsSqliteStore
// (@cutils/sqlite), then diff the JSON. Node-only (needs koffi binding).
import "koffi";
import "@cutils/sqlite/node-binding";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openStore } from "../../packages/db/dist/index.js";
import { CutilsSqliteStore } from "./dist/sqlite-store.js";

const dir = mkdtempSync(join(tmpdir(), "s1-parity-"));
const real = await openStore({ path: join(dir, "real.db") });
const spike = CutilsSqliteStore.open(join(dir, "spike.db"));
await spike.migrate();

const h = (u) => createHash("sha256").update(u).digest("hex");
const inputs = [
  {
    urlHash: h("https://a.example/x"),
    url: "https://a.example/x",
    title: "Alpha",
    source: "parity",
    addedAt: new Date("2026-01-01T00:00:00Z"),
    note: "n1",
    tags: ["t1", "t2"],
    needsBrowser: false,
    status: "inbox",
    state: "inbox",
    stateData: { enriched: true },
    enrichment: {
      category: "tech",
      priority: "high",
      why_it_matters: "w",
      read_minutes: 7,
      action: "read_now",
      expires_at: null,
      expiry_reason: null,
      confidence: 0.9,
    },
  },
  {
    urlHash: h("https://b.example/y"),
    url: "https://b.example/y",
    title: null,
    source: "parity",
    addedAt: null,
    note: null,
    tags: null,
    needsBrowser: true,
    status: "scheduled",
    state: "needs_browser",
    stateData: { reason: "paywall" },
  },
];

const results = {};
const run = async (name, fn) => {
  const [a, b] = await Promise.all([fn(real), fn(spike)]);
  results[name] = { real: a, spike: b };
};

for (const input of inputs) {
  await run(`upsert:${input.url}`, (s) => s.upsertLink(input));
}
// duplicate upsert (update path)
await run("upsert-dup", (s) =>
  s.upsertLink({ ...inputs[0], title: "Alpha2", note: "n2" }),
);
await run("getLink:1", (s) => s.getLink(1));
await run("getLink:missing", (s) => s.getLink(999));
await run("getByHash", (s) => s.getLinkByUrlHash(h("https://b.example/y")));
await run("listAll", (s) => s.listLinks());
await run("listStatus", (s) => s.listLinks({ status: "inbox" }));
await run("listLimit", (s) => s.listLinks({ limit: 1 }));
await run("countAll", (s) => s.countLinks());
await run("countStatus", (s) => s.countLinks({ status: "scheduled" }));
await run("schemaVersion", (s) => s.schemaVersion());
await run("meta", async (s) => {
  await s.setMeta("k", "v");
  return s.getMeta("k");
});

// canonical JSON: sort object keys recursively
const canon = (v) =>
  JSON.stringify(v, (k, val) => {
    if (k === "createdAt" || k === "updatedAt") return "<ts>";
    return val !== null && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val;
  });

let pass = 0;
let fail = 0;
for (const [name, r] of Object.entries(results)) {
  const a = canon(r.real);
  const b = canon(r.spike);
  if (a === b) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`);
    console.log("  real :", a.slice(0, 400));
    console.log("  spike:", b.slice(0, 400));
  }
}
await real.close();
await spike.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
