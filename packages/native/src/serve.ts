/// <reference path="./shims.d.ts" />
// Spike: `atento serve` native: @chttp/router + @chttp/static + raw-SQL /api routes.
import { createRouter, CtxCore } from "@chttp/router";
import { DiskAssets, serveStatic } from "@chttp/static";
import { getDb, str, num, COLS, toLink, linkJson, listJson, overviewJson } from "./lib.ts";

const uiDir = process.env.ATENTO_UI_DIR ?? "packages/ui/dist";
const port = Number(process.env.PORT ?? "4317");

function json(c: CtxCore, s: string, status: number): CtxCore {
  // c.text() forces text/plain; c.json() wants an object (we hold a pre-serialised string): use the _send seam.
  return c.status(status)._send(s, "application/json; charset=utf-8");
}

const app = createRouter();

app.get("/api/links", (c: CtxCore) => {
  const limit = num(Number(c.req.query("limit") ?? "50")) ?? 50;
  const items = listJson(c.req.query("status"), limit);
  return json(c, '{"items":' + items + "}", 200);
});

app.get("/api/links/:id", (c: CtxCore) => {
  const st = getDb().prepareRaw("SELECT " + COLS + " FROM links WHERE id = ?");
  const r = st.getRaw([Number(c.req.param("id"))]);
  st.finalize();
  if (r === undefined || r === null) return json(c, '{"error":"not found"}', 404);
  return json(c, linkJson(toLink(r)), 200);
});

app.get("/api/pipeline", (c: CtxCore) => json(c, overviewJson(), 200));

app.get("/api/events", (c: CtxCore) => {
  c.sink.writeHead(200, ["content-type", "text/event-stream", "cache-control", "no-cache"]);
  c.sink.write("event: overview\ndata: " + overviewJson() + "\n\n");
  c.sink.write("event: done\ndata: {}\n\n");
  c.sink.endStream();
  return c;
});

serveStatic(app, "/", new DiskAssets(uiDir), { spa: true, api: ["/api"] });

app.serve({ port });
console.log("listening on " + port);
