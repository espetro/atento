import { HNode, findAll, findFirst, textOf } from "./dom.js";

export class PageMeta {
  title = "";
  description = "";
  canonical = "";
  lang = "";
  author = "";
  published = "";
  siteName = "";
  ogTitle = "";
  ogDescription = "";
  ogImage = "";
  ogType = "";
  twitterCard = "";
  videoObject = false;
  links: string[] = [];
}

export function collapse(s: string): string {
  let out = "";
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 160) {
      space = true;
    } else {
      if (space && out !== "") out += " ";
      space = false;
      out += s.charAt(i);
    }
  }
  return out;
}

export function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch (e) {
    return "";
  }
}

function setIfEmpty(cur: string, v: string): string {
  return cur === "" ? collapse(v) : cur;
}

export function extractMeta(root: HNode, baseUrl: string): PageMeta {
  const m = new PageMeta();
  const html = findFirst(root, "html");
  if (html !== null) m.lang = html.attr("lang");
  const metas: HNode[] = [];
  findAll(root, "meta", metas);
  for (const el of metas) {
    const key = (el.attr("property") !== "" ? el.attr("property") : el.attr("name")).toLowerCase();
    const val = el.attr("content");
    if (val === "") continue;
    if (key === "description") m.description = setIfEmpty(m.description, val);
    else if (key === "og:description") m.ogDescription = setIfEmpty(m.ogDescription, val);
    else if (key === "og:title") m.ogTitle = setIfEmpty(m.ogTitle, val);
    else if (key === "og:image") m.ogImage = setIfEmpty(m.ogImage, resolveUrl(val, baseUrl));
    else if (key === "og:type") m.ogType = setIfEmpty(m.ogType, val);
    else if (key === "og:site_name") m.siteName = setIfEmpty(m.siteName, val);
    else if (key === "twitter:card") m.twitterCard = setIfEmpty(m.twitterCard, val);
    else if (key === "author" || key === "article:author") m.author = setIfEmpty(m.author, val);
    else if (key === "article:published_time" || key === "date" || key === "pubdate") m.published = setIfEmpty(m.published, val);
  }
  if (m.description === "") m.description = m.ogDescription;
  const links: HNode[] = [];
  findAll(root, "link", links);
  for (const l of links) {
    if (l.attr("rel").toLowerCase() === "canonical" && l.attr("href") !== "") {
      m.canonical = resolveUrl(l.attr("href"), baseUrl);
      break;
    }
  }
  const t = findFirst(root, "title");
  if (t !== null) m.title = collapse(textOf(t));
  if (m.title === "") m.title = m.ogTitle;
  const scripts: HNode[] = [];
  findAll(root, "script", scripts);
  for (const s of scripts) {
    if (s.attr("type").toLowerCase() === "application/ld+json") {
      const body = textOf(s);
      if (body.indexOf("VideoObject") >= 0) m.videoObject = true;
      if (m.published === "") {
        const k = body.indexOf("\"datePublished\"");
        if (k >= 0) {
          const q1 = body.indexOf("\"", body.indexOf(":", k) + 1);
          const q2 = q1 < 0 ? -1 : body.indexOf("\"", q1 + 1);
          if (q1 >= 0 && q2 > q1) m.published = body.slice(q1 + 1, q2);
        }
      }
    }
  }
  const anchors: HNode[] = [];
  findAll(root, "a", anchors);
  for (const a of anchors) {
    const h = a.attr("href");
    if (h === "" || h.charAt(0) === "#" || h.startsWith("javascript:") || h.startsWith("mailto:")) continue;
    const abs = resolveUrl(h, baseUrl);
    if (abs !== "" && m.links.indexOf(abs) < 0) m.links.push(abs);
    if (m.links.length >= 500) break;
  }
  return m;
}
