/// <reference path="./shims.d.ts" />
// Vendored parseMarkdown + parseUrlList + parseJsonLinks from
// packages/importers/src, plus the readTextFile helper.
// The @atento/importers package cannot join the scriptc build: as an
// --npm-static dependency it pulls the whole @atento/core barrel, which
// reaches enrichment.js -> zod/mini (a Node island). These parsers are
// pure string functions, so they are copied verbatim instead.
import { readFile } from "node:fs/promises";
import type { RawLink } from "@atento/core";

export const MARKDOWN_SOURCE = "markdown";
export const URL_LIST_SOURCE = "url-list";
export const JSON_SOURCE = "json";

const LINK_RE = /^\s*(?:[-*+]\s+)?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(?:\s+.*)?$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** parseMarkdown from packages/importers/src/markdown.ts. */
export function parseMarkdown(text: string): { links: RawLink[]; warnings: string[] } {
  const warnings: string[] = [];
  const links: RawLink[] = [];
  let heading: string | null = null;
  let skipped = 0;
  let inCodeFence = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (line === "") continue;

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const h = headingMatch[2];
      heading = h !== undefined && h.trim() !== "" ? h.trim() : null;
      continue;
    }

    const linkMatch = LINK_RE.exec(line);
    if (!linkMatch) continue;

    const text_ = linkMatch[1];
    const url = linkMatch[2];
    if (url === undefined || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      skipped += 1;
      continue;
    }
    const anchorText = text_ !== undefined ? text_.trim() : "";
    const title = heading !== null ? heading : anchorText !== "" ? anchorText : undefined;
    const link: RawLink = { url: url, source: MARKDOWN_SOURCE };
    if (title !== undefined) link.title = title;
    links.push(link);
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} markdown list item(s) that are not absolute http(s) links.`);
  }
  if (links.length === 0) {
    warnings.push("No links found in markdown file.");
  }
  return { links: links, warnings: warnings };
}

function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf("#");
  const withoutHash = hashIndex === -1 ? line : line.slice(0, hashIndex);
  return withoutHash.trim();
}

/** parseUrlList from packages/importers/src/url-list.ts. */
export function parseUrlList(text: string): { links: RawLink[]; warnings: string[] } {
  const warnings: string[] = [];
  const links: RawLink[] = [];
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const url = stripInlineComment(line);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      skipped += 1;
      continue;
    }
    links.push({ url: url, source: URL_LIST_SOURCE });
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} line(s) that are not absolute URLs.`);
  }
  if (links.length === 0) {
    warnings.push("No URLs found in file.");
  }
  return { links: links, warnings: warnings };
}

// ---------------------------------------------------------------- json
// Vendored from packages/importers/src/json.ts (parseJsonLinks and helpers).

const URL_KEYS = ["url", "link", "href"];
const TITLE_KEYS = ["title", "name", "text"];
const NOTE_KEYS = ["note", "description", "summary", "excerpt"];
const ADDED_KEYS = ["addedAt", "added_at", "date_added", "createdAt", "created_at", "time_added"];

/** parseJsonLinks from packages/importers/src/json.ts. */
export function parseJsonLinks(text: string): { links: RawLink[]; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { links: [], warnings: [`Malformed JSON: ${(err as Error).message}`] };
  }

  let items: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const candidate = obj["items"] ?? obj["links"] ?? obj["data"];
    if (Array.isArray(candidate)) items = candidate;
    else {
      return { links: [], warnings: ['JSON object has no "items" array; nothing to import.'] };
    }
  } else {
    return { links: [], warnings: ["JSON root is not an array or object; nothing to import."] };
  }

  const links: RawLink[] = [];
  let skipped = 0;
  for (const item of items) {
    const link = toRawLink(item);
    if (link !== null) links.push(link);
    else skipped += 1;
  }
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} JSON item(s) without a usable "url" field.`);
  }
  if (links.length === 0 && skipped === 0) {
    warnings.push("JSON file contained no items.");
  }
  return { links: links, warnings: warnings };
}

function toRawLink(item: unknown): RawLink | null {
  if (typeof item === "string") {
    const url = item.trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? { url: url, source: JSON_SOURCE } : null;
  }
  if (item === null || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const url = pickString(obj, URL_KEYS);
  if (url === undefined || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  const link: RawLink = { url: url, source: JSON_SOURCE };
  const title = pickString(obj, TITLE_KEYS);
  if (title !== undefined) link.title = title;
  const note = pickString(obj, NOTE_KEYS);
  if (note !== undefined) link.note = note;
  const tags = pickTags(obj);
  if (tags !== undefined) link.tags = tags;
  const added = pickDate(obj);
  if (added !== undefined) link.addedAt = added;
  return link;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function pickTags(obj: Record<string, unknown>): string[] | undefined {
  const v = obj["tags"];
  if (Array.isArray(v)) {
    const tags = v.filter((t): t is string => typeof t === "string");
    return tags.length > 0 ? tags : undefined;
  }
  if (typeof v === "string" && v.trim() !== "") {
    return v
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }
  return undefined;
}

function pickDate(obj: Record<string, unknown>): Date | undefined {
  for (const key of ADDED_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim() !== "") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- fs
// Vendored from packages/importers/src/fs-utils.ts (readTextFile only).

/** Read a file, returning null (plus a warning) instead of throwing. */
export async function readTextFile(
  filePath: string,
): Promise<{ text: string | null; warning: string | null }> {
  try {
    const text = await readFile(filePath, "utf8");
    return { text: text, warning: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EACCES" || e.code === "EPERM") {
      return {
        text: null,
        warning: `Cannot read ${filePath}: permission denied (${e.code}). Grant Full Disk Access to the terminal in System Settings -> Privacy & Security -> Full Disk Access.`,
      };
    }
    if (e.code === "ENOENT") {
      return { text: null, warning: `Cannot read ${filePath}: file not found.` };
    }
    return { text: null, warning: `Cannot read ${filePath}: ${e.message}` };
  }
}
