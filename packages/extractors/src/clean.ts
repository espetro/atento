/**
 * Per-site cleanup of logged-in browser captures.
 *
 * agent-browser `read` dumps everything on the page: navigation menus,
 * keyboard-shortcut hints, the logged-in viewer's own profile, footers and
 * language lists. That chrome pollutes the stored markdown and the LLM
 * enrichment. This module strips it per site with simple text anchors.
 *
 * Rules:
 * - Pure function, never throws.
 * - When a site's anchor is not found the input is returned unchanged:
 *   never return empty output from non-empty input.
 * - No content is removed to hit a size target.
 */

/** First index of any marker in the text, or -1. */
function indexOfAny(text: string, markers: string[]): number {
  let best = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/**
 * x.com: drop the leading keyboard-shortcut / tab-strip boilerplate and keep
 * the conversation or timeline. The sidebar ("Search filters", trending,
 * "Who to follow") and the footer after the timeline are chrome too.
 */
function cleanX(text: string): string {
  const anchor = text.indexOf("# Search timeline");
  if (anchor !== -1) {
    const rest = text.slice(anchor);
    const sidebar = indexOfAny(rest, ["\n##\n\nSearch filters", "\n##\n\nWho to follow"]);
    return sidebar === -1 ? rest : rest.slice(0, sidebar).trimEnd();
  }
  // No timeline anchor: fall back to stripping only the empty-heading
  // keyboard-shortcut preamble up to the first real heading.
  const match = text.match(/^\s*##\s*\n[\s\S]*?(?=#\s)/);
  return match ? text.slice(match[0].length) : text;
}

/**
 * LinkedIn: keep the feed post (author, headline, age, body) and its
 * comments. Everything before the "Feed post" heading is the viewer's own
 * nav/profile/Premium upsell; the ad options and footer after the post body
 * are chrome.
 */
function cleanLinkedIn(text: string): string {
  const anchor = text.indexOf("## Feed post");
  if (anchor === -1) return text;
  const rest = text.slice(anchor);
  const tail = indexOfAny(rest, [
    "\n## Ad Options",
    "\n## Don’t want to see this",
    "\nAbout\n\nAccessibility",
  ]);
  return tail === -1 ? rest : rest.slice(0, tail).trimEnd();
}

/** Left-nav single words Instagram dumps at the top of a capture. */
const IG_NAV_LINES = new Set([
  "Home",
  "Reels",
  "Messages",
  "Search",
  "Notifications",
  "Create",
  "Profile",
  "More",
  "Also from Meta",
]);

/**
 * Instagram: drop the left-nav words, the trailing footer with the language
 * list and the stray duplicate caption block. Keep author, caption,
 * hashtags and comment/like counts.
 */
function cleanInstagram(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (line === "" || IG_NAV_LINES.has(line)) start += 1;
    else break;
  }
  let cleaned = lines.slice(start).join("\n");
  // Footer starts at the Meta link block; the trailing "## Caption" echo is
  // chrome too.
  const tail = indexOfAny(cleaned, ["\nMeta\n\nAbout", "\nMessages\n\n## Caption"]);
  if (tail !== -1) cleaned = cleaned.slice(0, tail).trimEnd();
  if (start === 0 && tail === -1) return text;
  return cleaned.trimEnd();
}

type SiteCleaner = (text: string) => string;

const SITE_CLEANERS: Array<[test: (host: string) => boolean, clean: SiteCleaner]> = [
  [(host) => host === "x.com" || host.endsWith(".x.com"), cleanX],
  [(host) => host === "linkedin.com" || host.endsWith(".linkedin.com"), cleanLinkedIn],
  [(host) => host === "instagram.com" || host.endsWith(".instagram.com"), cleanInstagram],
];

/**
 * Strip site chrome from a browser capture, dispatching on the URL hostname.
 * Unknown hosts pass through unchanged; a missing anchor passes through
 * unchanged; the function never throws.
 */
export function cleanBrowserMarkdown(url: string, markdown: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [test, clean] of SITE_CLEANERS) {
      if (test(host)) return clean(markdown);
    }
  } catch {
    // Not a parseable URL or an unexpected shape: pass through.
  }
  return markdown;
}