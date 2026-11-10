/**
 * Page snapshots, taken when the user opens a link. single-file-cli drives
 * the installed Chrome and saves the rendered page as one self-contained
 * HTML file (CSS, images, fonts inlined; scripts removed). monolith is the
 * browserless fallback for static pages. Captures run one at a time.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const CAPTURE_TIMEOUT_MS = 90_000
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 3600 * 1000
const MAX_BYTES = 40 * 1024 * 1024

export type SnapshotRequest = 'queued' | 'running' | 'fresh' | 'unavailable'

export interface Snapshotter {
  /** Queue a capture unless a fresh one exists or one is already pending. */
  request(url: string): Promise<SnapshotRequest>
  /** Snapshot HTML for a url, or null. */
  read(url: string): Promise<Buffer | null>
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    )
  })
}

function chromePath(): string | null {
  const candidates = [
    process.env.ATENTO_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null
}

function singleFileEntry(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve('single-file-cli/package.json')
    const entry = join(dirname(pkg), 'single-file-node.js')
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

function monolithPath(): string | null {
  const bundled = join(dirname(process.execPath), 'monolith')
  const candidates = [process.env.ATENTO_MONOLITH, bundled]
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null
}

async function captureWithSingleFile(url: string, out: string): Promise<boolean> {
  const chrome = chromePath()
  const entry = singleFileEntry()
  if (!chrome || !entry) return false
  await run(process.execPath, [
    entry,
    url,
    out,
    '--browser-executable-path',
    chrome,
    '--browser-load-max-time',
    '45000',
  ])
  return true
}

async function captureWithMonolith(url: string, out: string): Promise<boolean> {
  const bin = monolithPath()
  if (!bin) return false
  await run(bin, [url, '-j', '-q', '-o', out])
  return true
}

export function createSnapshotter(
  pagesDir: string,
  keyOf: (url: string) => string,
): Snapshotter {
  const pending = new Set<string>()
  let tail: Promise<void> = Promise.resolve()

  const fileFor = (url: string) => join(pagesDir, `${keyOf(url)}.snap.html`)

  async function isFresh(url: string): Promise<boolean> {
    try {
      return Date.now() - (await stat(fileFor(url))).mtimeMs < SNAPSHOT_MAX_AGE_MS
    } catch {
      return false
    }
  }

  async function capture(url: string): Promise<void> {
    await mkdir(pagesDir, { recursive: true })
    const tmp = `${fileFor(url)}.tmp`
    try {
      let ok = false
      try {
        ok = await captureWithSingleFile(url, tmp)
      } catch {
        ok = false
      }
      if (!ok) ok = await captureWithMonolith(url, tmp)
      if (!ok) return
      const size = (await stat(tmp)).size
      if (size < 200 || size > MAX_BYTES) return
      await rename(tmp, fileFor(url))
    } catch {
      // Offline or the page refused: keep the previous snapshot.
    } finally {
      await rm(tmp, { force: true })
    }
  }

  return {
    async request(url) {
      if (!/^https?:\/\//i.test(url)) return 'unavailable'
      if (await isFresh(url)) return 'fresh'
      if (pending.has(url)) return 'running'
      if (!chromePath() && !monolithPath()) return 'unavailable'
      pending.add(url)
      tail = tail.then(() => capture(url)).finally(() => pending.delete(url))
      return 'queued'
    },
    async read(url) {
      try {
        return await readFile(fileFor(url))
      } catch {
        return null
      }
    },
  }
}

