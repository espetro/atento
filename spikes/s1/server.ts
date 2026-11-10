/// <reference path="./shims.d.ts" />
/**
 * S1 spike — @chttp/router serving a slice of the atento API on top of
 * the @cutils/sqlite Store adapter. Routes mirror packages/server/src:
 *   GET  /health          (spike-only liveness)
 *   GET  /api/links       (≈ GET /api/links in hono server)
 *   GET  /api/links/:id   (≈ GET /api/links/:id)
 *   POST /api/links       (capture-style insert, subset of POST semantics)
 *
 * Build:  scriptc build server.ts --npm-static @chttp/router \
 *           --npm-static @cutils/sqlite --ffi node_modules/@cutils/sqlite/ffi.json \
 *           -o atento-s1
 */
import { createRouter } from "@chttp/router";
import type { CtxCore } from "@chttp/router";
import { CutilsSqliteStore } from "./sqlite-store.js";
import { createHash } from "node:crypto";

const dbPath = process.argv.length > 2 ? process.argv[2] : "atento-s1.db";
const port = process.argv.length > 3 ? Number(process.argv[3]) : 3777;

const store = CutilsSqliteStore.open(dbPath);
await store.migrate();

// Seed two rows on an empty db so the demo has data (idempotent by url_hash).
if ((await store.countLinks()) === 0) {
  await store.upsertLink({
    urlHash: createHash("sha256").update("https://example.com/a").digest("hex"),
    url: "https://example.com/a",
    title: "Example A",
    source: "spike-seed",
    addedAt: null,
    note: null,
    tags: null,
    needsBrowser: false,
    status: "inbox",
  });
  await store.upsertLink({
    urlHash: createHash("sha256").update("https://example.com/b").digest("hex"),
    url: "https://example.com/b",
    title: "Example B",
    source: "spike-seed",
    addedAt: null,
    note: null,
    tags: null,
    needsBrowser: false,
    status: "inbox",
  });
}

const app = createRouter();

app.get("/health", (c: CtxCore) => {
  return c.json({ ok: true, db: dbPath });
});

app.get("/api/links", async (c: CtxCore) => {
  const status = c.req.query("status");
  const links = await store.listLinks(
    status === null ? undefined : { status: status as never },
  );
  return c.json({ links, count: links.length });
});

app.get("/api/links/:id", async (c: CtxCore) => {
  const id = Number(c.req.param("id"));
  const link = await store.getLink(id);
  if (link === null) return c.status(404).json({ error: "not found" });
  return c.json(link);
});

app.post(
  "/api/links",
  async (c: CtxCore) => {
  const body = c.req.body();
  let parsed: { url?: string; title?: string };
  try {
    parsed = JSON.parse(body) as { url?: string; title?: string };
  } catch {
    return c.status(400).json({ error: "invalid json" });
  }
  if (parsed.url === undefined || parsed.url === "") {
    return c.status(400).json({ error: "url required" });
  }
  const url = parsed.url;
  const link = await store.upsertLink({
    urlHash: createHash("sha256").update(url).digest("hex"),
    url,
    title: parsed.title === undefined ? null : parsed.title,
    source: "api",
    addedAt: null,
    note: null,
    tags: null,
    needsBrowser: false,
    status: "inbox",
  });
  return c.status(201).json(link);
  },
  { body: true },
);

app.onError((err: unknown, c: CtxCore) => {
  const e = err as { message?: string; stack?: string };
  console.log("handler error:", e !== null && e.message !== undefined ? e.message : String(err));
  if (e !== null && e.stack !== undefined) console.log(e.stack);
  return c.status(500).json({ error: "internal" });
});
app.notFound((c: CtxCore) => c.status(404).json({ error: "not found" }));

app.serve({ port });
console.log(`atento-s1 listening on http://127.0.0.1:${port} (db=${dbPath})`);
