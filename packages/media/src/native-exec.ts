// Subprocess runner for the native build (yt-dlp, ffmpeg, the ASR CLI). No imports beyond node:child_process,
// so it compiles with scriptc. The timeout is spawnSync's own: execFile's timeout option is not supported
// natively (vercel-labs/scriptc#3529). Same result shape as ExecLike in download.ts.
import { spawnSync } from "node:child_process";

export class ExecOutcome {
  code = 0;
  stdout = "";
  stderr = "";
  timedOut = false;
}

export function runBlocking(file: string, args: string[], timeoutMs: number): ExecOutcome {
  const out = new ExecOutcome();
  const r = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  out.stdout = typeof r.stdout === "string" ? r.stdout : "";
  out.stderr = typeof r.stderr === "string" ? r.stderr : "";
  if (r.error !== undefined) {
    out.code = 1;
    out.timedOut = r.signal === "SIGKILL";
    if (out.stderr === "") out.stderr = String(r.error);
    return out;
  }
  out.code = r.status === null ? 1 : r.status;
  return out;
}
