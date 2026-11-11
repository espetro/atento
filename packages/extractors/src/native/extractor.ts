import { HNode, findAll, findFirst, parseHtml, textOf } from "./dom.js";
import { PageMeta, collapse, extractMeta } from "./meta.js";
import { pickContent } from "./readable.js";
import { toMarkdown } from "./markdown.js";

export class NativeExtract {
  markdown = "";
  title = "";
  meta: PageMeta = new PageMeta();
  needsBrowser = false;
  gone = 0;
  status = 0;
  finalUrl = "";
  wordCount = 0;
}

function countWords(s: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const sp = c === 32 || c === 10 || c === 9 || c === 13;
    if (!sp && !inWord) n++;
    inWord = !sp;
  }
  return n;
}

/** HTML to markdown, text and metadata. Pure: no network, never throws on odd input. */
export function extractHtml(html: string, url: string): NativeExtract {
  const r = new NativeExtract();
  r.finalUrl = url;
  const root = parseHtml(html);
  const base = baseOf(root, url);
  r.meta = extractMeta(root, base);
  const h1 = findFirst(root, "h1");
  r.title = r.meta.ogTitle !== "" ? r.meta.ogTitle : r.meta.title;
  if (r.title === "" && h1 !== null) r.title = collapse(textOf(h1));
  const content: HNode = pickContent(root);
  r.markdown = toMarkdown(content, base);
  r.wordCount = countWords(r.markdown);
  if (r.markdown === "") r.needsBrowser = true;
  return r;
}

function baseOf(root: HNode, url: string): string {
  const bases: HNode[] = [];
  findAll(root, "base", bases);
  if (bases.length > 0 && bases[0].attr("href") !== "") {
    try {
      return new URL(bases[0].attr("href"), url).href;
    } catch (e) {
      return url;
    }
  }
  return url;
}

import { FetchOptions, fetchPage } from "./fetcher.js";

/** Fetch then extract. Mirrors the Node router contract: 404/410 are final, 4xx/5xx and fetch errors need a browser. */
export async function extractUrl(url: string, opts: FetchOptions): Promise<NativeExtract> {
  const f = await fetchPage(url, opts);
  if (f.error !== "") {
    const r = new NativeExtract();
    r.needsBrowser = true;
    r.finalUrl = url;
    return r;
  }
  if (f.status === 404 || f.status === 410) {
    const r = new NativeExtract();
    r.gone = f.status;
    r.status = f.status;
    r.finalUrl = f.finalUrl;
    return r;
  }
  if (f.status >= 400) {
    const r = new NativeExtract();
    r.needsBrowser = true;
    r.status = f.status;
    r.finalUrl = f.finalUrl;
    return r;
  }
  const r = extractHtml(f.body, f.finalUrl);
  r.status = f.status;
  return r;
}
