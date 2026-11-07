/**
 * The MV3 background service worker.
 *
 * The chrome wiring only: read the active tab, run the injected content
 * script in the page, build the payload and hand it to the durable
 * outbox. Every decision lives in capture.ts, payload.ts, guard.ts,
 * bulk.ts, config.ts and queue.ts, which are plain modules with no chrome
 * dependency, so the decisions are unit tested offline.
 *
 * Durability rules from docs/extension.md: the outbox persists to
 * chrome.storage.local BEFORE any POST, the worker treats every handler
 * as a cold start (it is killed after ~30s idle), and a chrome.alarms
 * drain covers retries while the browser is open. Bulk captures (all
 * tabs, this window, highlighted tabs, bookmarks) go through the same
 * outbox as kind 'ingest' batches of at most 500 urls.
 */
import { runActiveTabCapture, type CaptureOutcome } from './capture.js'
import { createOutbox, type Outbox, type OutboxKind } from './queue.js'
import { serializeCapturePayload, type CapturePayload } from './payload.js'
import { EXTRACT_MESSAGE } from './messages.js'
import type { ExtractedPage } from './extractor.js'
import {
  authHeadersFor,
  endpointFor,
  readSettings,
  type ServerSettings,
} from './config.js'
import {
  buildIngestBatches,
  captureKey,
  collectBookmarkUrls,
  collectTabUrls,
  type BookmarkNode,
  type BulkTab,
} from './bulk.js'

/** How long the worker waits for the content script's message. */
const EXTRACT_TIMEOUT_MS = 5000

/** The alarm that drains the outbox while the browser is open. */
const DRAIN_ALARM = 'linkinbox-outbox-drain'
/** chrome.alarms minimum period is 30s; use exactly that. */
const DRAIN_PERIOD_MINUTES = 0.5

/** Context-menu ids for the bulk scopes. */
const MENU_ALL_TABS = 'linkinbox-bulk-all-tabs'
const MENU_WINDOW_TABS = 'linkinbox-bulk-window-tabs'
const MENU_HIGHLIGHTED = 'linkinbox-bulk-highlighted'
const MENU_BOOKMARKS = 'linkinbox-bulk-bookmarks'

let settings: ServerSettings | undefined

/** Used only if a drain somehow fires before the first settings read. */
const FALLBACK_SETTINGS: ServerSettings = {
  serverUrl: 'http://127.0.0.1:4173',
  token: '',
  apiToken: '',
  source: 'extension',
}

async function currentSettings(): Promise<ServerSettings> {
  settings = await readSettings(chrome.storage.local)
  return settings
}

/** The outbox, wired to live settings so a re-pair or URL change applies
 *  to retries without a worker restart. */
const outbox: Outbox = createOutbox({
  storage: chrome.storage.local,
  endpointFor: (kind: OutboxKind) => endpointFor(settings ?? FALLBACK_SETTINGS, kind),
  headersFor: (kind: OutboxKind) => authHeadersFor(settings ?? FALLBACK_SETTINGS, kind),
})

/** Enqueue one capture payload, then try to deliver it immediately. */
async function deliverCapture(payload: CapturePayload): Promise<{ ok: boolean; error?: string }> {
  const key = captureKey(payload.url, payload.capturedAt)
  try {
    await outbox.enqueue({
      idempotencyKey: key,
      kind: 'capture',
      url: payload.url,
      payload: serializeCapturePayload(payload),
    })
    await outbox.drain()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const item = outbox.get(key)
  if (item === undefined) return { ok: true }
  return { ok: false, error: item.lastError ?? 'still queued' }
}

/** Resolve with the first extract message from the tab, or null on timeout. */
function waitForExtract(tabId: number, timeoutMs: number): Promise<ExtractedPage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener)
      resolve(null)
    }, timeoutMs)
    function listener(
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ): undefined {
      if (sender.tab?.id !== tabId) return
      const msg = message as { type?: string; payload?: ExtractedPage }
      if (msg?.type !== EXTRACT_MESSAGE) return
      clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      resolve(msg.payload ?? null)
    }
    chrome.runtime.onMessage.addListener(listener)
  })
}

/**
 * Run the content script in the tab and take the extracted page back. The
 * content script is injected on demand (activeTab), so nothing runs on a
 * page the user did not act on.
 */
async function extractTab(tab: chrome.tabs.Tab): Promise<ExtractedPage | null> {
  if (tab.id === undefined) return null
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    })
    return await waitForExtract(tab.id, EXTRACT_TIMEOUT_MS)
  } catch {
    return null
  }
}

async function handleAction(): Promise<CaptureOutcome> {
  const s = await currentSettings()
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.url === undefined) {
    return { status: 'refused', reason: 'no active tab' }
  }
  const tabUrl = tab.url
  return runActiveTabCapture({
    tab: {
      id: tab.id,
      url: tabUrl,
      title: tab.title,
      incognito: tab.incognito === true,
    },
    extract: async () => {
      const extracted = await extractTab(tab)
      if (extracted !== null) return extracted
      // The content script could not run (a chrome:// page, a PDF viewer, a
      // page the browser blocks scripting on). Fall back to the tab title so
      // the capture still carries something rather than nothing.
      return { body: tab.title ?? tabUrl, title: tab.title }
    },
    getToken: async () => s.token,
    // Both paths go through the same durable outbox: `send` persists the
    // item first and then drains; `enqueue` is the synchronous fallback —
    // capture.ts does not await it, and dedupe by key makes it a no-op in
    // the normal case (send already persisted the item).
    send: async (payload) => deliverCapture(payload),
    enqueue: (payload) => {
      void outbox.enqueue({
        idempotencyKey: captureKey(payload.url, payload.capturedAt),
        kind: 'capture',
        url: payload.url,
        payload: serializeCapturePayload(payload),
      })
      return true
    },
    source: s.source,
  })
}

export type BulkScope = 'all-tabs' | 'window-tabs' | 'highlighted' | 'bookmarks'

/**
 * Collect the URLs for one bulk scope and queue them as ingest batches.
 * Never throws: collection failures come back as an error string.
 */
async function handleBulk(scope: BulkScope): Promise<{
  batches: number
  urls: number
  error?: string
}> {
  let urls: string[]
  if (scope === 'bookmarks') {
    const tree = (await chrome.bookmarks.getTree()) as BookmarkNode[]
    urls = collectBookmarkUrls(tree)
  } else {
    const query =
      scope === 'all-tabs'
        ? {}
        : scope === 'window-tabs'
          ? { currentWindow: true }
          : { currentWindow: true, highlighted: true }
    const tabs = (await chrome.tabs.query(query)) as BulkTab[]
    urls = collectTabUrls(tabs)
  }
  const batches = buildIngestBatches(urls, {
    note: `bulk capture (${scope})`,
    tags: ['extension'],
  })
  for (const batch of batches) {
    const first = batch.payload.urls[0] ?? ''
    const label =
      batch.payload.urls.length > 3
        ? `${first} (+${batch.payload.urls.length - 1})`
        : batch.payload.urls.join(', ')
    await outbox.enqueue({
      idempotencyKey: batch.idempotencyKey,
      kind: 'ingest',
      url: label,
      payload: JSON.stringify(batch.payload),
    })
  }
  if (batches.length > 0) await outbox.drain()
  return { batches: batches.length, urls: urls.length }
}

function installMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ALL_TABS,
      title: 'Save all tabs to linkinbox',
      contexts: ['action'],
    })
    chrome.contextMenus.create({
      id: MENU_WINDOW_TABS,
      title: "Save this window's tabs to linkinbox",
      contexts: ['action'],
    })
    chrome.contextMenus.create({
      id: MENU_HIGHLIGHTED,
      title: 'Save highlighted tabs to linkinbox',
      contexts: ['action'],
    })
    chrome.contextMenus.create({
      id: MENU_BOOKMARKS,
      title: 'Save all bookmarks to linkinbox',
      contexts: ['action'],
    })
  })
}

const MENU_SCOPES: Record<string, BulkScope> = {
  [MENU_ALL_TABS]: 'all-tabs',
  [MENU_WINDOW_TABS]: 'window-tabs',
  [MENU_HIGHLIGHTED]: 'highlighted',
  [MENU_BOOKMARKS]: 'bookmarks',
}

async function drainOutbox(): Promise<void> {
  await currentSettings()
  await outbox.drain()
}

// ---- wiring ------------------------------------------------------------

// Load settings and the persisted outbox, then drain whatever is due. The
// worker may be starting cold; every handler below re-reads what it needs.
void (async () => {
  await outbox.ready
  await currentSettings()
  await outbox.drain()
})()

chrome.action.onClicked.addListener(() => {
  void handleAction()
})

chrome.contextMenus.onClicked.addListener((info) => {
  const scope = MENU_SCOPES[info.menuItemId]
  if (scope !== undefined) void handleBulk(scope)
})

chrome.runtime.onInstalled.addListener(() => {
  installMenus()
})

chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: DRAIN_PERIOD_MINUTES })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DRAIN_ALARM) void drainOutbox()
})

// A message API for a future popup/options bulk trigger and for status.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type?: string; scope?: BulkScope }
  if (msg?.type === 'linkinbox:bulk' && msg.scope !== undefined) {
    void handleBulk(msg.scope).then(sendResponse)
    return true
  }
  return false
})
