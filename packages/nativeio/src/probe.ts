import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

async function main(): Promise<void> {
  const r = await fetch("http://127.0.0.1:" + (process.argv[2] ?? "8080") + "/", { redirect: "manual" });
  console.log(r.status, r.headers.get("location"));
  const t = await r.text();
  console.log(t.length);
  const re = /<title[^>]*>([\s\S]*?)<\/title>/i;
  const m = re.exec(t);
  console.log(m === null ? "none" : m[1]);
  const u = new URL("../a?b=1", "http://x.com/q/r");
  console.log(u.href);
  const p = spawnSync("echo", ["hi"], { encoding: "utf8" });
  console.log(p.stdout);
  console.log(readFileSync("/etc/hosts", "utf8").length);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1000);
  console.log(ac.signal.aborted);
}
main();
