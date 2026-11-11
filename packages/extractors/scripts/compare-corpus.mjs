// Compare the native extractor binary with defuddle and readability on saved pages.
// usage: node scripts/compare-corpus.mjs <native-binary> <dir-of-html> [urls.txt]
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const Defuddle = require("defuddle").default ?? require("defuddle").Defuddle ?? require("defuddle");
const { Readability } = require("@mozilla/readability");
const [bin, dir, urlFile] = process.argv.slice(2);
const urls = urlFile ? readFileSync(urlFile, "utf8").split("\n") : [];
const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);
function f1(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  const m = new Map();
  for (const w of b) m.set(w, (m.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of a) { const c = m.get(w) ?? 0; if (c > 0) { hit++; m.set(w, c - 1); } }
  const p = hit / Math.max(a.length, 1), r = hit / Math.max(b.length, 1);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}
const rows = [];
const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
files.forEach((f, i) => {
  const html = readFileSync(join(dir, f), "utf8");
  const url = urls[i] || "https://example.com/";
  const t0 = performance.now();
  let nat = { markdown: "", title: "", links: 0 };
  try { nat = JSON.parse(execFileSync(bin, [join(dir, f), url], { maxBuffer: 1 << 26 }).toString()); } catch {}
  const natMs = performance.now() - t0;
  let def = "", rd = "";
  try { def = new Defuddle(parseHTML(html).document, { url }).parse().content ?? ""; def = def.replace(/<[^>]+>/g, " "); } catch {}
  try { const a = new Readability(parseHTML(html).document).parse(); rd = a?.textContent ?? ""; } catch {}
  const nw = words(nat.markdown);
  rows.push({ f, nat: nw.length, def: words(def).length, rd: words(rd).length, f1def: f1(nw, words(def)), f1rd: f1(nw, words(rd)), f1defrd: f1(words(rd), words(def)), natMs: Math.round(natMs) });
});
const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
for (const r of rows) console.log(r.f, `nat=${r.nat} def=${r.def} rd=${r.rd} F1(nat,def)=${r.f1def.toFixed(2)} F1(nat,rd)=${r.f1rd.toFixed(2)} F1(rd,def)=${r.f1defrd.toFixed(2)} ${r.natMs}ms`);
const thr = 0.8;
console.log(`pages=${rows.length} meanF1(nat,def)=${mean("f1def").toFixed(3)} meanF1(nat,rd)=${mean("f1rd").toFixed(3)} meanF1(rd,def)=${mean("f1defrd").toFixed(3)}`);
console.log(`diff rate vs defuddle (F1<${thr}): ${(rows.filter((r) => r.f1def < thr).length / rows.length * 100).toFixed(0)}%  vs readability: ${(rows.filter((r) => r.f1rd < thr).length / rows.length * 100).toFixed(0)}%  baseline readability-vs-defuddle: ${(rows.filter((r) => r.f1defrd < thr).length / rows.length * 100).toFixed(0)}%`);
