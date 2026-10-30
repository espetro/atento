import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Extractor, ExtractResult } from "./types.js";
import { cleanBrowserMarkdown } from "./clean.js";
import { isLoginWall } from "./browser.js";

/**
 * Stealth browser extractor: Patchright (a patched Playwright fork) behind
 * the same Extractor interface as the agent-browser extractor.
 *
 * Why a second engine: a plain automated Chromium is trivially fingerprinted
 * (navigator.webdriver, CDP artifacts). Patchright patches those away, so it
 * is used for the login-gated hosts a normal browser cannot get into. It is
 * NOT a bypass for account-level bans, captchas or rate limits: it only
 * reduces the fingerprint risk.
 *
 * The Patchright import is dynamic and optional: the package builds and every
 * test runs when Patchright is not installed. The browser is reached only
 * through the injected launcher, so the unit tests use fake page objects and
 * never touch the network.
 */

/** Subdirectory of the host profile where the Patchright user data lives. */
export const PATCHRIGHT_PROFILE_SUFFIX = "patchright";

/** Default dwell before reading the page: the pacing median. */
export const DEFAULT_DWELL_MS = 20_000;

/** Default scroll distance: a small, human-sized step. */
export const DEFAULT_SCROLL_PX = 420;

/**
 * The subset of a Patchright page the extractor uses. Keeping it narrow lets
 * the tests pass a plain fake object.
 */
export interface PatchrightPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  /** Rendered page HTML. */
  content(): Promise<string>;
  /** Visible text of the rendered page, read through a page expression. */
  evaluate(expression: string): Promise<string>;
  scroll?(pixels: number): Promise<void>;
  close?(): Promise<void>;
}

/** A launched persistent context. Closing it flushes the profile to disk. */
export interface PatchrightContext {
  pages(): PatchrightPage[];
  newPage(): Promise<PatchrightPage>;
  close(): Promise<void>;
}

/** The Chromium launcher surface the extractor needs. */
export interface PatchrightLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: {
      headless?: boolean;
      executablePath?: string;
      viewport?: { width: number; height: number } | null;
      args?: string[];
      locale?: string;
    },
  ): Promise<PatchrightContext>;
}

/**
 * Injected browser launcher. Tests pass a fake; production uses the default
 * Patchright launcher.
 */
export type PatchrightLaunch = (
  userDataDir: string,
  options: { headless: boolean; executablePath?: string },
) => Promise<PatchrightContext>;

export interface PatchrightExtractorOptions {
  /** Base dir for saved login profiles. */
  profilesDir?: string;
  /** The Chromium binary to run. Overridable for BrowserOS or an anti-detect build. */
  executablePath?: string;
  /** Headless by default; the login flow opens a headed context instead. */
  headless?: boolean;
  /** Browser launch options, injected in tests. */
  launch?: PatchrightLaunch;
  /** Override the profile-existence check (tests). */
  profileExists?: (dir: string) => boolean;
  /** Wait before reading the page; injected so tests never sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Human-like scroll before reading; injected so tests need no browser. */
  scroll?: (pixels: number, profileDir: string) => Promise<void>;
  /** Sampled dwell time in ms; defaults to the pacing median (20s). */
  dwellMs?: number;
  /** Sampled scroll distance in px; defaults to a small human-like step. */
  scrollPx?: number;
  /** Navigation timeout in ms. */
  timeoutMs?: number;
}

/** Profile dir for a host: ~/.linkinbox/profiles/<host>/patchright */
export function patchrightProfileDir(url: string, profilesDir?: string): string {
  const host = new URL(url).hostname;
  const base = profilesDir ?? join(homedir(), ".linkinbox", "profiles");
  return join(base, host, PATCHRIGHT_PROFILE_SUFFIX);
}

/**
 * The default launcher: a dynamic import of the optional `patchright`
 * package. When the package is not installed the import fails and the
 * extractor reports needsBrowser, never a crash.
 */
export const defaultPatchrightLaunch: PatchrightLaunch = async (userDataDir, options) => {
  const mod = (await import("patchright")) as unknown as {
    chromium?: { launchPersistentContext: PatchrightLauncher["launchPersistentContext"] };
    default?: { chromium?: { launchPersistentContext: PatchrightLauncher["launchPersistentContext"] } };
  };
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error("patchright: no chromium browser type");
  return await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    // A real window size keeps the viewport out of the fingerprint.
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"],
  });
};

/**
 * The page text as markdown.
 *
 * The rendered HTML is converted with the same html-to-markdown path the
 * other extractors use (turndown over a linkedom document). When that fails
 * the visible text is used with its headings kept as markdown.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const trimmed = html.trim();
  if (!trimmed) return "";
  try {
    const [{ parseHTML }, { default: TurndownService }] = await Promise.all([
      import("linkedom"),
      import("turndown"),
    ]);
    const { document } = parseHTML(trimmed);
    const globalDoc = (globalThis as { document?: Document }).document;
    (globalThis as { document?: Document }).document = document;
    try {
      const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      return turndown.turndown(trimmed).trim();
    } finally {
      (globalThis as { document?: Document }).document = globalDoc;
    }
  } catch {
    return "";
  }
}

/**
 * Fallback conversion: the visible text, with the heading levels it carries.
 * Never throws; returns the empty string when there is nothing to convert.
 */
export function textToMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(`${heading[1]!} ${heading[2]!}`.trim());
      continue;
    }
    out.push(trimmed);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The Patchright extractor.
 *
 * Never throws: a missing profile, a failed launch, an empty page or a login
 * wall all come back as needsBrowser with empty markdown so the router can
 * flag the link instead of crashing the run.
 */
export function createPatchrightExtractor(options: PatchrightExtractorOptions = {}): Extractor {
  const launch = options.launch ?? defaultPatchrightLaunch;
  const exists = options.profileExists ?? ((dir: string) => existsSync(dir));
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  const scrollPx = options.scrollPx ?? DEFAULT_SCROLL_PX;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    name: "patchright",
    async extract(url: string): Promise<ExtractResult> {
      const profileDir = patchrightProfileDir(url, options.profilesDir);
      if (!exists(profileDir)) {
        return { markdown: "", needsBrowser: true, meta: { missingProfile: true } };
      }
      let context: PatchrightContext | undefined;
      try {
        context = await launch(profileDir, {
          headless: options.headless !== false,
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        });
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // Human pacing: dwell the sampled time and scroll a little before
        // reading, so a logged-in session does not look like a script. Both
        // steps are injected, so tests never sleep.
        if (options.sleep) await options.sleep(dwellMs);
        if (options.scroll) await options.scroll(scrollPx, profileDir);
        else if (page.scroll) await page.scroll(scrollPx);
        const html = await page.content();
        let markdown = await htmlToMarkdown(html);
        if (!markdown) {
          const text = await page.evaluate("document.body ? document.body.innerText : ''");
          markdown = textToMarkdown(text);
        }
        if (!markdown) {
          return { markdown: "", needsBrowser: true, meta: { emptyPage: true } };
        }
        if (isLoginWall(markdown)) {
          // The host refused the session: the caller must stop, not retry.
          return {
            markdown: "",
            needsBrowser: true,
            meta: { blocked: true, reason: "login_wall" },
          };
        }
        return {
          markdown: cleanBrowserMarkdown(url, markdown),
          meta: { engine: "patchright" },
        };
      } catch (error) {
        return {
          markdown: "",
          needsBrowser: true,
          meta: { failed: true, engine: "patchright", error: shortError(error) },
        };
      } finally {
        if (context) {
          try {
            await context.close();
          } catch {
            // Closing is best effort: the profile is flushed by the browser.
          }
        }
      }
    },
  };
}

/** First line of an error, trimmed to a sane length for the metadata. */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.slice(0, 200);
}
