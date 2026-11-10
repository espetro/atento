/**
 * The message contract between the content script and the worker.
 *
 * It lives in its own module so the worker can import the message name
 * without pulling the content script's side effects into its bundle.
 */

/** The message the content script sends after extracting the page. */
export const EXTRACT_MESSAGE = 'atento:extracted'
