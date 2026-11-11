import { HNode, textOf } from "./dom.js";
import { collapse, resolveUrl } from "./meta.js";

const INLINE = ["a", "span", "strong", "b", "em", "i", "code", "small", "sub", "sup", "abbr", "mark", "u", "s", "del", "ins", "cite", "q", "time", "img", "br", "kbd", "font", "bdi", "data", "var", "wbr", "picture", "tt"];

function repeat(s: string, n: number): string {
  let o = "";
  for (let i = 0; i < n; i++) o += s;
  return o;
}

function inlineOf(node: HNode, base: string): string {
  if (node.isText()) {
    let t = node.text.replace(/[ \t\r\n\f ]+/g, " ");
    return t;
  }
  const tag = node.tag;
  if (tag === "br") return "\n";
  if (tag === "img") {
    const alt = collapse(node.attr("alt"));
    const src = resolveUrl(node.attr("src"), base);
    if (src === "" || src.startsWith("data:")) return "";
    return "![" + alt + "](" + src + ")";
  }
  let inner = "";
  for (const c of node.children) inner += inlineOf(c, base);
  if (tag === "code" || tag === "tt" || tag === "kbd") {
    const t = inner.trim();
    return t === "" ? "" : "`" + t + "`";
  }
  const lead = inner.startsWith(" ") ? " " : "";
  const trail = inner.endsWith(" ") && inner.length > 1 ? " " : "";
  const core = inner.trim();
  if (core === "") return inner === "" ? "" : " ";
  if (tag === "strong" || tag === "b") return lead + "**" + core + "**" + trail;
  if (tag === "em" || tag === "i") return lead + "*" + core + "*" + trail;
  if (tag === "a") {
    const href = node.attr("href");
    if (href === "" || href.charAt(0) === "#" || href.startsWith("javascript:")) return inner;
    const abs = resolveUrl(href, base);
    if (abs === "") return inner;
    return lead + "[" + core + "](" + abs + ")" + trail;
  }
  return inner;
}

function tidyInline(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t !== "") out.push(t);
  }
  return out.join("  \n");
}

function listItems(list: HNode, base: string, depth: number, out: string[]): void {
  const ordered = list.tag === "ol";
  let n = 0;
  for (const li of list.children) {
    if (li.tag !== "li") continue;
    n++;
    const marker = ordered ? String(n) + ". " : "- ";
    const pad = repeat("  ", depth);
    let text = "";
    const nested: HNode[] = [];
    for (const c of li.children) {
      if (c.tag === "ul" || c.tag === "ol") nested.push(c);
      else if (c.tag === "p" || c.tag === "div") text += " " + inlineOf(c, base);
      else text += inlineOf(c, base);
    }
    const t = collapse(text);
    if (t !== "") out.push(pad + marker + t);
    for (const nl of nested) listItems(nl, base, depth + 1, out);
  }
}

function tableRows(table: HNode, base: string): string {
  const rows: HNode[] = [];
  collectRows(table, rows);
  const lines: string[] = [];
  let first = true;
  for (const r of rows) {
    const cells: string[] = [];
    for (const c of r.children) {
      if (c.tag === "td" || c.tag === "th") cells.push(collapse(inlineOf(c, base)).replace(/\|/g, "\\|"));
    }
    if (cells.length === 0) continue;
    lines.push("| " + cells.join(" | ") + " |");
    if (first) {
      lines.push("|" + repeat(" --- |", cells.length));
      first = false;
    }
  }
  return lines.join("\n");
}

function collectRows(node: HNode, out: HNode[]): void {
  for (const c of node.children) {
    if (c.tag === "tr") out.push(c);
    else if (!c.isText() && c.tag !== "table") collectRows(c, out);
  }
}

function flush(buf: string, out: string[]): void {
  const t = tidyInline(buf);
  if (t !== "") out.push(t);
}

function blocks(node: HNode, base: string, out: string[]): void {
  let buf = "";
  for (const c of node.children) {
    if (c.isText() || INLINE.indexOf(c.tag) >= 0) {
      buf += inlineOf(c, base);
      continue;
    }
    flush(buf, out);
    buf = "";
    const tag = c.tag;
    if (tag.length === 2 && tag.charAt(0) === "h" && tag.charAt(1) >= "1" && tag.charAt(1) <= "6") {
      const t = collapse(inlineOf(c, base));
      if (t !== "") out.push(repeat("#", Number(tag.charAt(1))) + " " + t);
    } else if (tag === "p") {
      flush(inlineOf(c, base), out);
    } else if (tag === "ul" || tag === "ol") {
      const items: string[] = [];
      listItems(c, base, 0, items);
      if (items.length > 0) out.push(items.join("\n"));
    } else if (tag === "pre") {
      const code = textOf(c).replace(/^\n+|\s+$/g, "");
      if (code !== "") out.push("```\n" + code + "\n```");
    } else if (tag === "blockquote") {
      const inner: string[] = [];
      blocks(c, base, inner);
      const body = inner.join("\n\n");
      if (body !== "") out.push(body.split("\n").map((l) => (l === "" ? ">" : "> " + l)).join("\n"));
    } else if (tag === "hr") {
      out.push("---");
    } else if (tag === "table") {
      const t = tableRows(c, base);
      if (t !== "") out.push(t);
    } else {
      blocks(c, base, out);
    }
  }
  flush(buf, out);
}

export function toMarkdown(content: HNode, baseUrl: string): string {
  const out: string[] = [];
  blocks(content, baseUrl, out);
  return out.join("\n\n").trim();
}
