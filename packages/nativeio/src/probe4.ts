import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
const r = spawnSync("sleep", ["5"], { encoding: "utf8", timeout: 500, killSignal: "SIGKILL" });
console.log("status", r.status, "signal", r.signal, r.error === undefined ? "noerr" : String(r.error));
const d = mkdtempSync("/tmp/nio-x-");
writeFileSync(d + "/a.bin", new Uint8Array([1, 2, 3]));
rmSync(d, { recursive: true, force: true });
