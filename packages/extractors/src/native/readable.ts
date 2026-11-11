import { HNode, findAll, textOf } from "./dom.js";
import { collapse } from "./meta.js";

const DROP_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "nav", "aside", "footer", "form", "button", "select", "input", "textarea", "dialog", "canvas", "video", "audio", "object", "embed", "head", "link", "meta", "menu", "label"];
const NOISE_WORDS = ["comment", "sidebar", "footer", "navbar", "nav-", "-nav", "menu", "cookie", "banner", "promo", "share", "social", "related", "breadcrumb", "newsletter", "subscribe", "advert", "modal", "popup", "skip-link", "toolbar", "pagination", "sponsor", "widget"];

function noisy(el: HNode): boolean {
  if (el.hasAttr("hidden") || el.attr("aria-hidden") === "true") return true;
  const role = el.attr("role");
  if (role === "navigation" || role === "banner" || role === "contentinfo" || role === "complementary" || role === "dialog") return true;
  const id = (el.attr("class") + " " + el.attr("id")).toLowerCase();
  if (id.length < 2) return false;
  for (const w of NOISE_WORDS) {
    if (id.indexOf(w) >= 0) return true;
  }
  return false;
}

function containsTag(node: HNode, tag: string): boolean {
  for (const c of node.children) {
    if (c.tag === tag) return true;
    if (!c.isText() && containsTag(c, tag)) return true;
  }
  return false;
}

/** Detach non-content elements in place. */
export function prune(node: HNode): void {
  const keep: HNode[] = [];
  for (const c of node.children) {
    if (c.isText()) {
      keep.push(c);
      continue;
    }
    if (DROP_TAGS.indexOf(c.tag) >= 0) continue;
    if (c.tag === "header" && !containsTag(c, "h1") && !containsTag(c, "h2")) continue;
    if (c.tag !== "body" && c.tag !== "html" && c.tag !== "article" && c.tag !== "main" && noisy(c) && !containsTag(c, "article") && !containsTag(c, "main")) continue;
    prune(c);
    keep.push(c);
  }
  node.children = keep;
}

export function textLen(node: HNode): number {
  if (node.isText()) return collapse(node.text).length;
  let n = 0;
  for (const c of node.children) n += textLen(c);
  return n;
}

function linkLen(node: HNode): number {
  if (node.tag === "a") return textLen(node);
  if (node.isText()) return 0;
  let n = 0;
  for (const c of node.children) n += linkLen(c);
  return n;
}

function bestOf(list: HNode[]): HNode | null {
  let best: HNode | null = null;
  let bestLen = 0;
  for (const el of list) {
    const l = textLen(el);
    if (l > bestLen) {
      best = el;
      bestLen = l;
    }
  }
  return best;
}

function scoreParas(node: HNode, cands: HNode[]): void {
  for (const c of node.children) {
    if (c.isText()) continue;
    if (c.tag === "p" || c.tag === "pre" || c.tag === "blockquote" || c.tag === "td" || c.tag === "li") {
      const t = collapse(textOf(c));
      if (t.length >= 25) {
        let commas = 0;
        for (let i = 0; i < t.length; i++) if (t.charAt(i) === ",") commas++;
        let pts = 1 + commas + Math.min(Math.floor(t.length / 100), 3);
        if (c.tag === "li") pts = pts / 2;
        const p = c.parent;
        if (p !== null) {
          if (p.score === 0) cands.push(p);
          p.score += pts;
          const gp = p.parent;
          if (gp !== null) {
            if (gp.score === 0) cands.push(gp);
            gp.score += pts / 2;
          }
        }
      }
    }
    scoreParas(c, cands);
  }
}

/** Pick the node holding the main readable content. Mutates the tree (prune). */
export function pickContent(root: HNode): HNode {
  prune(root);
  const articles: HNode[] = [];
  findAll(root, "article", articles);
  const art = bestOf(articles);
  const mains: HNode[] = [];
  findAll(root, "main", mains);
  const main = bestOf(mains);
  const bodies: HNode[] = [];
  findAll(root, "body", bodies);
  const body = bodies.length > 0 ? bodies[0] : root;
  const bodyLen = textLen(body);
  if (art !== null && textLen(art) >= 400 && textLen(art) * 3 >= bodyLen) return art;
  if (main !== null && textLen(main) >= 400 && textLen(main) * 2 >= bodyLen) return main;
  const cands: HNode[] = [];
  scoreParas(body, cands);
  let top: HNode | null = null;
  let topScore = 0;
  for (const c of cands) {
    const tl = textLen(c);
    const density = tl === 0 ? 1 : linkLen(c) / tl;
    const s = c.score * (1 - density);
    if (s > topScore) {
      topScore = s;
      top = c;
    }
  }
  if (top === null) return body;
  const par = top.parent;
  if (par !== null && par.tag !== "body" && par.tag !== "#root" && par.score >= top.score * 0.8 && par.score > 0) return par;
  return top;
}
