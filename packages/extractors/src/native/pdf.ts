// PDF text for the native build. Strategy, in order:
//  1. pdftotext (poppler) if present: best quality (fonts, CMaps, layout).
//  2. mutool (mupdf) if present.
//  3. A tiny built-in decoder: Flate streams plus Tj/TJ literal strings. It only handles simple
//     fonts with a standard encoding; subsetted Identity-H fonts (most Word/LaTeX output) yield
//     little or nothing, and the caller then reports needsBrowser.
// The subprocess timeout uses spawnSync's own timeout, not execFile's (vercel-labs/scriptc#3529).
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

export class PdfText {
  text = "";
  engine = "";
  error = "";
}

function latin1(b: Uint8Array): string {
  let s = "";
  const step = 8192;
  for (let i = 0; i < b.length; i += step) {
    const end = Math.min(b.length, i + step);
    let chunk = "";
    for (let j = i; j < end; j++) chunk += String.fromCharCode(b[j]);
    s += chunk;
  }
  return s;
}

function runTool(bin: string, args: string[], timeoutMs: number): string {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  if (r.error !== undefined || r.status !== 0) return "";
  return typeof r.stdout === "string" ? r.stdout : "";
}

function unescapeLiteral(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const n = s.charAt(i + 1);
    if (n === "n") out += "\n";
    else if (n === "r" || n === "b" || n === "f") out += " ";
    else if (n === "t") out += " ";
    else if (n >= "0" && n <= "7") {
      let j = i + 1;
      let v = 0;
      let k = 0;
      while (k < 3 && j < s.length && s.charAt(j) >= "0" && s.charAt(j) <= "7") {
        v = v * 8 + (s.charCodeAt(j) - 48);
        j++;
        k++;
      }
      out += String.fromCharCode(v);
      i = j;
      continue;
    } else out += n;
    i += 2;
  }
  return out;
}

/** Pull text out of one decoded content stream. */
function contentText(c: string): string {
  let out = "";
  let i = 0;
  const n = c.length;
  while (i < n) {
    const ch = c.charAt(i);
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = c.charAt(j);
        if (d === "\\") j++;
        else if (d === "(") depth++;
        else if (d === ")") depth--;
        j++;
      }
      out += unescapeLiteral(c.slice(i + 1, j - 1));
      i = j;
      continue;
    }
    if (ch === "]") {
      // end of a TJ array: a word gap is unknowable here, keep text joined
      i++;
      continue;
    }
    if (c.startsWith("T*", i) || c.startsWith("ET", i) || c.startsWith("Td", i) || c.startsWith("TD", i)) {
      if (!out.endsWith("\n")) out += "\n";
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

function printableRatio(s: string): number {
  if (s.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 32 && c <= 126) || c === 10) ok++;
  }
  return ok / s.length;
}

function nativeText(bytes: Uint8Array): string {
  const s = latin1(bytes);
  let out = "";
  let pos = 0;
  while (true) {
    const st = s.indexOf("stream", pos);
    if (st < 0) break;
    if (s.startsWith("endstream", st - 3)) {
      pos = st + 6;
      continue;
    }
    let b = st + 6;
    if (s.charAt(b) === "\r") b++;
    if (s.charAt(b) === "\n") b++;
    const en = s.indexOf("endstream", b);
    if (en < 0) break;
    const dictStart = s.lastIndexOf("obj", st);
    const dict = dictStart < 0 ? "" : s.slice(dictStart, st);
    let body = s.slice(b, en);
    pos = en + 9;
    if (dict.indexOf("/Image") >= 0 || dict.indexOf("/FontFile") >= 0 || dict.indexOf("/Length1") >= 0) continue;
    if (dict.indexOf("/FlateDecode") >= 0) {
      try {
        const raw = new Uint8Array(body.length);
        for (let k = 0; k < body.length; k++) raw[k] = body.charCodeAt(k) & 255;
        body = latin1(new Uint8Array(inflateSync(raw)));
      } catch (e) {
        continue;
      }
    }
    if (body.indexOf("BT") < 0 || (body.indexOf("Tj") < 0 && body.indexOf("TJ") < 0)) continue;
    const part = contentText(body);
    if (printableRatio(part) < 0.9) continue;
    out += part + "\n";
  }
  return out;
}

function tidy(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    const t = l.replace(/[ \t\f]+/g, " ").trim();
    if (t === "") {
      blank++;
      if (blank === 1 && out.length > 0) out.push("");
    } else {
      blank = 0;
      out.push(t);
    }
  }
  return out.join("\n").trim();
}

export function extractPdfText(bytes: Uint8Array, timeoutMs: number): PdfText {
  const r = new PdfText();
  if (bytes.length < 8 || latin1(bytes.slice(0, 5)) !== "%PDF-") {
    r.error = "not a PDF";
    return r;
  }
  const dir = mkdtempSync("/tmp/atento-pdf-");
  const file = dir + "/in.pdf";
  try {
    writeFileSync(file, bytes);
    let t = runTool("pdftotext", ["-layout", "-enc", "UTF-8", "-q", file, "-"], timeoutMs);
    if (t.trim() !== "") {
      r.engine = "pdftotext";
      r.text = tidy(t);
    } else {
      t = runTool("mutool", ["draw", "-q", "-F", "txt", "-o", "-", file], timeoutMs);
      if (t.trim() !== "") {
        r.engine = "mutool";
        r.text = tidy(t);
      } else {
        t = nativeText(bytes);
        if (t.trim() !== "") {
          r.engine = "builtin";
          r.text = tidy(t);
        }
      }
    }
  } catch (e) {
    r.error = String(e);
  }
  rmSync(dir, { recursive: true, force: true });
  if (r.text === "" && r.error === "") r.error = "no text layer found";
  return r;
}
