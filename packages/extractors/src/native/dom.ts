// Tiny HTML tokenizer and tree builder, authored inside the scriptc compilable subset.
// No imports outside this directory so it builds natively and runs on Node unchanged.

export class HNode {
  tag = "";
  text = "";
  attrs: string[] = [];
  children: HNode[] = [];
  parent: HNode | null = null;
  score = 0;
  constructor(tag: string) {
    this.tag = tag;
  }
  isText(): boolean {
    return this.tag === "#text";
  }
  attr(name: string): string {
    for (let i = 0; i + 1 < this.attrs.length; i += 2) {
      if (this.attrs[i] === name) return this.attrs[i + 1];
    }
    return "";
  }
  hasAttr(name: string): boolean {
    for (let i = 0; i + 1 < this.attrs.length; i += 2) {
      if (this.attrs[i] === name) return true;
    }
    return false;
  }
}

const VOID = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];
const RAW = ["script", "style", "textarea", "title"];

function isVoid(t: string): boolean {
  return VOID.indexOf(t) >= 0;
}

const ENT_NAMES = ["amp", "lt", "gt", "quot", "apos", "nbsp", "copy", "reg", "hellip", "mdash", "ndash", "lsquo", "rsquo", "ldquo", "rdquo", "bull", "middot", "laquo", "raquo", "trade", "times", "euro", "pound", "yen", "deg", "para", "sect", "larr", "rarr", "uarr", "darr", "eacute", "egrave", "aacute", "agrave", "iacute", "oacute", "uacute", "ntilde", "ccedil", "uuml", "ouml", "auml", "szlig"];
const ENT_VALS = ["&", "<", ">", "\"", "'", " ", "©", "®", "…", "—", "–", "‘", "’", "“", "”", "•", "·", "«", "»", "™", "×", "€", "£", "¥", "°", "¶", "§", "←", "→", "↑", "↓", "é", "è", "á", "à", "í", "ó", "ú", "ñ", "ç", "ü", "ö", "ä", "ß"];

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charAt(i);
    if (c !== "&") {
      out += c;
      i++;
      continue;
    }
    const semi = s.indexOf(";", i + 1);
    if (semi < 0 || semi - i > 10) {
      out += c;
      i++;
      continue;
    }
    const name = s.slice(i + 1, semi);
    let rep = "";
    if (name.charAt(0) === "#") {
      let code = 0;
      if (name.charAt(1) === "x" || name.charAt(1) === "X") code = parseInt(name.slice(2), 16);
      else code = parseInt(name.slice(1), 10);
      if (code > 0 && code < 0x110000 && code === code) rep = String.fromCodePoint(code);
    } else {
      const k = ENT_NAMES.indexOf(name);
      if (k >= 0) rep = ENT_VALS[k];
    }
    if (rep === "") {
      out += c;
      i++;
    } else {
      out += rep;
      i = semi + 1;
    }
  }
  return out;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13 || code === 12;
}
function isNameChar(code: number): boolean {
  return !(isSpace(code) || code === 62 || code === 47 || code === 61);
}

const P_CLOSERS = ["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"];

function addText(parent: HNode, text: string): void {
  if (text === "") return;
  const t = new HNode("#text");
  t.text = text;
  t.parent = parent;
  parent.children.push(t);
}

function hasOpen(cur: HNode, tag: string, stop: string[]): boolean {
  let n: HNode | null = cur;
  while (n !== null) {
    if (n.tag === tag) return true;
    if (stop.indexOf(n.tag) >= 0) return false;
    n = n.parent;
  }
  return false;
}

function closeTo(cur: HNode, tag: string): HNode {
  let n: HNode | null = cur;
  while (n !== null) {
    if (n.tag === tag) return n.parent === null ? n : n.parent;
    n = n.parent;
  }
  return cur;
}

/** Parse an HTML string into a tree rooted at a synthetic "#root" node. */
export function parseHtml(src: string): HNode {
  const root = new HNode("#root");
  let cur = root;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      addText(cur, decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) addText(cur, decodeEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const next = i + 1 < n ? src.charCodeAt(i + 1) : 0;
    if (next === 33 || next === 63) {
      const e = src.indexOf(">", i + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (next === 47) {
      let j = i + 2;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      const name = src.slice(i + 2, j).toLowerCase();
      const e = src.indexOf(">", j);
      i = e < 0 ? n : e + 1;
      if (name !== "") cur = closeTo(cur, name);
      continue;
    }
    const isAlpha = (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
    if (!isAlpha) {
      addText(cur, "<");
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    const tag = src.slice(i + 1, j).toLowerCase();
    const el = new HNode(tag);
    let selfClose = false;
    while (j < n) {
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      if (j >= n) break;
      const ch = src.charCodeAt(j);
      if (ch === 62) {
        j++;
        break;
      }
      if (ch === 47) {
        selfClose = true;
        j++;
        continue;
      }
      const ns = j;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      if (j === ns) {
        j++;
        continue;
      }
      const an = src.slice(ns, j).toLowerCase();
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      let av = "";
      if (j < n && src.charCodeAt(j) === 61) {
        j++;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        const q = j < n ? src.charCodeAt(j) : 0;
        if (q === 34 || q === 39) {
          const qe = src.indexOf(q === 34 ? "\"" : "'", j + 1);
          const end = qe < 0 ? n : qe;
          av = src.slice(j + 1, end);
          j = qe < 0 ? n : qe + 1;
        } else {
          const vs = j;
          while (j < n && !isSpace(src.charCodeAt(j)) && src.charCodeAt(j) !== 62) j++;
          av = src.slice(vs, j);
        }
      }
      if (!el.hasAttr(an)) {
        el.attrs.push(an);
        el.attrs.push(decodeEntities(av));
      }
    }
    i = j;
    // implicit end tags
    if (tag === "li") {
      if (hasOpen(cur, "li", ["ul", "ol"])) cur = closeTo(cur, "li");
    } else if (tag === "dt" || tag === "dd") {
      if (hasOpen(cur, "dt", ["dl"])) cur = closeTo(cur, "dt");
      else if (hasOpen(cur, "dd", ["dl"])) cur = closeTo(cur, "dd");
    } else if (tag === "tr") {
      if (hasOpen(cur, "tr", ["table"])) cur = closeTo(cur, "tr");
    } else if (tag === "td" || tag === "th") {
      if (hasOpen(cur, "td", ["tr"])) cur = closeTo(cur, "td");
      else if (hasOpen(cur, "th", ["tr"])) cur = closeTo(cur, "th");
    } else if (tag === "option") {
      if (hasOpen(cur, "option", ["select"])) cur = closeTo(cur, "option");
    }
    if (P_CLOSERS.indexOf(tag) >= 0 && hasOpen(cur, "p", ["div", "td", "th", "li", "body", "blockquote"])) {
      cur = closeTo(cur, "p");
    }
    el.parent = cur;
    cur.children.push(el);
    if (isVoid(tag) || selfClose) continue;
    if (RAW.indexOf(tag) >= 0) {
      let e = src.indexOf("</" + tag, i);
      const eu = src.indexOf("</" + tag.toUpperCase(), i);
      if (e < 0 || (eu >= 0 && eu < e)) e = eu;
      if (e < 0) e = n;
      const raw = src.slice(i, e);
      addText(el, tag === "script" || tag === "style" ? raw : decodeEntities(raw));
      const ge = src.indexOf(">", e);
      i = ge < 0 ? n : ge + 1;
      continue;
    }
    cur = el;
  }
  return root;
}

export function findAll(node: HNode, tag: string, out: HNode[]): void {
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    if (!c.isText()) findAll(c, tag, out);
  }
}

export function findFirst(node: HNode, tag: string): HNode | null {
  for (const c of node.children) {
    if (c.tag === tag) return c;
    if (!c.isText()) {
      const r = findFirst(c, tag);
      if (r !== null) return r;
    }
  }
  return null;
}

export function textOf(node: HNode): string {
  if (node.isText()) return node.text;
  let s = "";
  for (const c of node.children) s += textOf(c);
  return s;
}
