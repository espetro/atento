/**
 * The MV3 background service worker.
 *
 * The chrome wiring only: read the active tab, run the injected content
 * script in the page, build the payload and send it. Every decision lives
 * in capture.ts, payload.ts, guard.ts and queue.ts, which are plain modules
 * with no chrome dependency, so the decisions are unit tested offline.
 *
 * The worker is killed after about 30 seconds of inactivity and restarts on
 * the next event, so the queue in this proof of concept is in memory and
 * does NOT survive a restart. Persisting it in chrome.storage.local is
 * milestone M3 in docs/extension.md.
 */
import { runActiveTabCapture, type CaptureOutcome } from './capture.js'
import { createCaptureQueue } from './queue.js'
import { postCapture } from './client.js'
import { EXTRACT_MESSAGE } from './messages.js'
import type { ExtractedPage } from './extractor.js'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4173/capture'

/** How long the worker waits for the content script's message. */
const EXTRACT_TIMEOUT_MS = 5000

interface Settings {
  endpoint: string
  token: string
  source: string
}

async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(['endpoint', 'token', 'source'])
  return {
    endpoint: typeof stored['endpoint'] === 'string' ? stored['endpoint'] : DEFAULT_ENDPOINT,
    token: typeof stored['token'] === 'string' ? stored['token'] : '',
    source: typeof stored['source'] === 'string' ? stored['source'] : 'extension',
  }
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
  const settings = await readSettings()
  const queue = createCaptureQueue({
    endpoint: settings.endpoint,
    token: settings.token,
  })
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
    getToken: async () => settings.token,
    send: async (payload, token) => {
      const result = await postCapture(payload, {
        endpoint: settings.endpoint,
        token,
        fetch: fetch.bind(globalThis),
      })
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    },
    enqueue: (payload) => {
      queue.enqueue(payload.url, JSON.stringify(payload))
      return true
    },
    source: settings.source,
  })
}

chrome.action.onClicked.addListener(() => {
  void handleAction()
})
