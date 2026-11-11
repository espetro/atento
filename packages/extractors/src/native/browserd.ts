// Client for the atento-browserd subprocess (packages/browser/bin/atento-browserd.mjs).
// JSON lines over stdin/stdout, one request per spawn. spawnSync's own timeout bounds the child.

import { spawnSync } from "node:child_process";

export class BrowserdConfig {
  /** Interpreter, default "node". */
  command = "node";
  /** Path to atento-browserd.mjs. Empty means no browser available. */
  script = "";
  executablePath = "";
  profileDir = "";
  timeoutMs = 45000;
  dwellMs = 0;
}

export class CaptureResult {
  ok = false;
  status = 0;
  finalUrl = "";
  title = "";
  html = "";
  error = "";
}

export function browserdConfigFromEnv(env: { [k: string]: string | undefined }): BrowserdConfig {
  const c = new BrowserdConfig();
  const script = env["ATENTO_BROWSERD"];
  if (script !== undefined) c.script = script;
  const node = env["ATENTO_BROWSERD_NODE"];
  if (node !== undefined && node !== "") c.command = node;
  const exe = env["ATENTO_BROWSER_EXECUTABLE"];
  if (exe !== undefined) c.executablePath = exe;
  return c;
}

export function captureHtml(cfg: BrowserdConfig, url: string): CaptureResult {
  const out = new CaptureResult();
  if (cfg.script === "") {
    out.error = "browser not configured (set ATENTO_BROWSERD)";
    return out;
  }
  let req = '{"id":1,"op":"capture","url":' + JSON.stringify(url) + ',"timeoutMs":' + cfg.timeoutMs + ',"dwellMs":' + cfg.dwellMs;
  if (cfg.executablePath !== "") req += ',"executablePath":' + JSON.stringify(cfg.executablePath);
  if (cfg.profileDir !== "") req += ',"profileDir":' + JSON.stringify(cfg.profileDir);
  req += "}\n";
  const r = spawnSync(cfg.command, [cfg.script], { input: req, encoding: "utf8", timeout: cfg.timeoutMs + 15000, killSignal: "SIGKILL" });
  if (r.error !== undefined) {
    out.error = "browserd failed to run: " + String(r.error);
    return out;
  }
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      const j = JSON.parse(line) as { [k: string]: unknown };
      if (j["ok"] === true) {
        out.ok = true;
        const st = j["status"];
        const fu = j["finalUrl"];
        const ti = j["title"];
        const ht = j["html"];
        out.status = typeof st === "number" ? st : 0;
        out.finalUrl = typeof fu === "string" ? fu : url;
        out.title = typeof ti === "string" ? ti : "";
        out.html = typeof ht === "string" ? ht : "";
      } else {
        const er = j["error"];
        out.error = typeof er === "string" ? er : "browserd reported failure";
      }
    } catch (e) {
      out.error = "browserd returned invalid JSON";
    }
    return out;
  }
  out.error = "browserd produced no output";
  return out;
}
