/**
 * Global single-key shortcuts (the keyboard contract in
 * docs/screens/screen-INDEX.txt). Handlers register per view; the
 * dispatcher stays inert while an editable element or an open dialog
 * has focus.
 */

export type ShortcutHandler = () => void

const handlers = new Map<string, Set<ShortcutHandler>>()

/** Number of currently-open modal dialogs (Dialog.svelte manages this). */
let openDialogs = 0
export function dialogOpened() {
  openDialogs += 1
}
export function dialogClosed() {
  openDialogs = Math.max(0, openDialogs - 1)
}
export function dialogsOpen() {
  return openDialogs > 0
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Register a handler for a single key (e.g. 'j', 'a', '1'). Returns unsub. */
export function onShortcut(key: string, fn: ShortcutHandler): () => void {
  const k = key.toLowerCase()
  let set = handlers.get(k)
  if (!set) {
    set = new Set()
    handlers.set(k, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) handlers.delete(k)
  }
}

let listening = false

function ensureListener() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('keydown', (e) => {
    if (openDialogs > 0) return
    if (isEditableTarget(e.target)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const set = handlers.get(key)
    if (!set || set.size === 0) return
    e.preventDefault()
    for (const fn of set) fn()
  })
}

/** Start the dispatcher (App calls once on mount). */
export function startKeyboard() {
  ensureListener()
}
