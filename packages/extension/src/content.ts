/**
 * The content script: run in the page, extract the DOM, send it back.
 *
 * It never reads cookies, never touches the network and never stores
 * anything. The extraction is the shared stub from extractor.ts; milestone
 * M2 in docs/extension.md replaces it with a bundled Readability (or
 * defuddle) plus turndown.
 *
 * The script is injected on demand with chrome.scripting.executeScript
 * (the activeTab permission), so it runs only when the user clicks the
 * action, not on every page.
 */
import { extractPage } from './extractor.js'
import { EXTRACT_MESSAGE } from './messages.js'

chrome.runtime.sendMessage(
  { type: EXTRACT_MESSAGE, payload: extractPage(document) },
  () => {
    // The callback swallows the "no receiving end" error: the worker may
    // have been torn down between the injection and the message.
    void chrome.runtime.lastError
  },
)
