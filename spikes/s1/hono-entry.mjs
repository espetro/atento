import { createRequire } from "node:module";
const req = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { serve } = req("@hono/node-server");
const { openStore } = await import("../../packages/db/dist/index.js");
const { createApp } = await import("../../packages/server/dist/index.js");
const store = await openStore({ path: process.argv[2] ?? ":memory:" });
const app = createApp(store, {});
const port = Number(process.argv[3] ?? 3999);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log("listening", info.port);
});
