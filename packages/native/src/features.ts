// Spike: runtime feature probe for the things atento needs: top-level await,
// fs, child_process (spawn, execFile, spawnSync), fetch (http and https), timers, SSE-ish loops.
import * as fs from "node:fs";
import { spawn, spawnSync, execFile } from "node:child_process";

const results: string[] = [];
function ok(name: string, detail: string): void {
  results.push(name + ": ok " + detail);
}

// top-level await
await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
ok("tla", "");

// fs
fs.writeFileSync("/tmp/atento-spike/feat.txt", "hello");
ok("fs.sync", fs.readFileSync("/tmp/atento-spike/feat.txt", "utf8"));
await fs.promises.writeFile("/tmp/atento-spike/feat2.txt", "world");
ok("fs.promises", await fs.promises.readFile("/tmp/atento-spike/feat2.txt", "utf8"));

// child_process
const sync = spawnSync("echo", ["from-spawnSync"], { encoding: "utf8" });
ok("spawnSync", String(sync.stdout).trim() + " status=" + sync.status);

const out = await new Promise<string>((resolve) => {
  execFile("echo", ["from-execFile"], (err, stdout) => resolve(String(stdout).trim()));
});
ok("execFile", out);

const spawned = await new Promise<string>((resolve) => {
  const child = spawn("sh", ["-c", "echo from-spawn; exit 3"]);
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
  });
  child.on("close", (code: number | null) => resolve(buf.trim() + " code=" + code));
});
ok("spawn", spawned);

// fetch
const local = await fetch("http://127.0.0.1:4317/api/pipeline");
ok("fetch.http", local.status + " " + (await local.text()).slice(0, 30));
try {
  const r = await fetch("https://example.com/");
  ok("fetch.https", String(r.status) + " " + (await r.text()).length + "B");
} catch (e) {
  results.push("fetch.https: FAIL " + String(e));
}

// JSON.parse into unknown + dynamic property access
const o = JSON.parse('{"a":{"b":[1,2,3]}}') as { a: { b: number[] } };
ok("json", String(o.a.b.length));

console.log(results.join("\n"));
