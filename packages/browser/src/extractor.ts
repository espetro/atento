/**
 * PageReaderPort -> Extractor bridge.
 *
 * The extractors router speaks `Extractor.extract(url)`; the browser
 * adapters speak `PageReaderPort.open({host, profile})` + PageSession.
 * This wrapper reproduces the pre-M1 browser-extractor contract exactly:
 * missing profile -> needsBrowser/missingProfile, empty page ->
 * emptyPage, login wall -> blocked/login_wall, failure -> failed, and the
 * same human pacing (dwell + scroll) between goto and read.
 */
import { existsSync } from 'node:fs'
import { browserProfileDir } from '@linkinbox/core'
import type { PageReaderPort, PageSession } from '@linkinbox/core'
import {
  cleanBrowserMarkdown,
  htmlToMarkdown,
  isLoginWall,
  textToMarkdown,
  type ExtractResult,
  type Extractor,
} from '@linkinbox/extractors'
import type { BrowserRegistry } from './registry.js'

export interface PageReaderExtractorOptions {
  /** Base profiles dir; the profile dir is <dir>/<host>/<adapterId>. */
  profilesDir?: string
  /** Override the profile-existence check (tests). */
  profileExists?: (dir: string) => boolean
  /** Wait before reading; injected so tests never sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Dwell time in ms; default the pacing median (20s). */
  dwellMs?: number
  /** Scroll distance in px; default a small human step. */
  scrollPx?: number
  /** Navigation/read timeout in ms. */
  timeoutMs?: number
}

const DEFAULT_DWELL_MS = 20_000
const DEFAULT_SCROLL_PX = 420

export function pageReaderExtractor(
  port: PageReaderPort,
  options: PageReaderExtractorOptions = {},
): Extractor {
  const exists = options.profileExists ?? ((dir: string) => existsSync(dir))
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS
  const scrollPx = options.scrollPx ?? DEFAULT_SCROLL_PX

  return {
    name: `browser:${port.id}`,
    async extract(url: string): Promise<ExtractResult> {
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        return { markdown: '', needsBrowser: true, meta: { failed: true, error: 'bad url' } }
      }
      const profileDir = options.profilesDir
        ? browserProfileDir(options.profilesDir, host, port.id)
        : undefined
      // Adapters without persistent profiles (cdp-attach) need no saved
      // session: the running browser is the session.
      if (port.caps.persistentProfile && profileDir && !exists(profileDir)) {
        return { markdown: '', needsBrowser: true, meta: { missingProfile: true } }
      }
      let session: PageSession | undefined
      try {
        session = await port.open({
          host,
          ...(profileDir
            ? { profile: { host, adapterId: port.id, path: profileDir } }
            : {}),
        })
        await session.goto(url)
        // Human pacing: dwell the sampled time and scroll a little before
        // reading, so a logged-in session does not look like a script.
        if (options.sleep) await options.sleep(dwellMs)
        if (session.scroll) await session.scroll(scrollPx)
        const content = await session.html()
        let markdown =
          port.contentFormat === 'markdown' ? content.trim() : await htmlToMarkdown(content)
        if (!markdown && port.contentFormat !== 'markdown') {
          // DOM adapters may still yield a text-only page.
          markdown = textToMarkdown(content.replace(/<[^>]+>/g, ' '))
        }
        await session.close().catch(() => undefined)
        if (!markdown.trim()) {
          return { markdown: '', needsBrowser: true, meta: { emptyPage: true } }
        }
        if (isLoginWall(markdown)) {
          // The host refused the session: the caller must stop, not retry.
          return {
            markdown: '',
            needsBrowser: true,
            meta: { blocked: true, reason: 'login_wall' },
          }
        }
        return {
          markdown: cleanBrowserMarkdown(url, markdown),
          meta: { adapter: port.id },
        }
      } catch (error) {
        try {
          await session?.close()
        } catch {
          // best effort
        }
        return {
          markdown: '',
          needsBrowser: true,
          meta: {
            failed: true,
            adapter: port.id,
            error: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error),
          },
        }
      }
    },
  }
}

/**
 * Build the adapterId -> Extractor map the router and the browse reader
 * share: every registry adapter with a PageReaderPort becomes an
 * Extractor over the new profile layout. `overrides` win per adapter id
 * (tests inject fakes here).
 */
export function browserAdapterReaders(
  registry: BrowserRegistry,
  options: PageReaderExtractorOptions & {
    overrides?: Record<string, Extractor>
  } = {},
): Record<string, Extractor> {
  const { overrides, ...extractorOptions } = options
  const out: Record<string, Extractor> = {}
  for (const id of Object.keys(registry.config.adapters ?? {})) {
    const instance = registry.adapter(id)
    if (!instance?.reader) continue
    out[id] = overrides?.[id] ?? pageReaderExtractor(instance.reader, extractorOptions)
  }
  return out
}
