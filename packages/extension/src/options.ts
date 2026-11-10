// Options page wiring: server URL, tokens, source identity, the pairing
// flow and the outbox status. Everything lives in chrome.storage.local —
// a bearer token is a secret: never synced, never logged.
import { readSettings, normalizeServerUrl, type ServerSettings } from './config.js'
import { redeemPairingCode } from './pairing.js'
import type { OutboxItem } from './queue.js'

const FIELDS = ['serverUrl', 'token', 'apiToken', 'source'] as const

const statusEl = document.getElementById('status') as HTMLParagraphElement
const originEl = document.getElementById('origin') as HTMLParagraphElement
const outboxStatsEl = document.getElementById('outboxStats') as HTMLParagraphElement
const deadListEl = document.getElementById('deadList') as HTMLDivElement
const clearDeadEl = document.getElementById('clearDead') as HTMLButtonElement
const pairCodeEl = document.getElementById('pairCode') as HTMLInputElement
const pairEl = document.getElementById('pair') as HTMLButtonElement

originEl.textContent = `This extension's origin: ${chrome.runtime.getURL('').replace(/\/$/, '')}`

function flash(message: string): void {
  statusEl.textContent = message
  void setTimeout(() => {
    statusEl.textContent = ''
  }, 4000)
}

function valuesFromForm(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of FIELDS) {
    const el = document.getElementById(name) as HTMLInputElement
    values[name] = el.value.trim()
  }
  return values
}

function fillForm(settings: ServerSettings): void {
  const el = (name: string) => document.getElementById(name) as HTMLInputElement
  el('serverUrl').value = settings.serverUrl
  el('token').value = settings.token
  el('apiToken').value = settings.apiToken
  el('source').value = settings.source
}

void readSettings(chrome.storage.local).then(fillForm)

// Legacy field: an old install stored the full /capture URL under
// `endpoint`. Show it migrated in the form so a save writes the new shape.
void chrome.storage.local.get(['endpoint']).then((stored) => {
  const legacy = stored['endpoint']
  if (typeof legacy !== 'string' || legacy === '') return
  // Only fill when nothing has populated the field yet.
  const el = document.getElementById('serverUrl') as HTMLInputElement
  if (el.value === '') el.value = legacy.replace(/\/(capture|api\/ingest)\/?$/, '')
})

document.getElementById('save')?.addEventListener('click', () => {
  void chrome.storage.local.set(valuesFromForm()).then(() => flash('Saved.'))
})

pairEl?.addEventListener('click', () => {
  const code = pairCodeEl.value.trim()
  if (code === '') {
    flash('Paste the pairing code first.')
    return
  }
  void (async () => {
    pairEl.disabled = true
    try {
      const settings = await readSettings(chrome.storage.local)
      // The code redeems against the server URL in the form if the user
      // edited it, else the stored one.
      const serverUrl = normalizeServerUrl(
        (document.getElementById('serverUrl') as HTMLInputElement).value,
      )
      const result = await redeemPairingCode(code, {
        settings: { ...settings, serverUrl },
        fetch: fetch.bind(globalThis),
      })
      if (!result.ok) {
        flash(`Pairing failed: ${result.error}`)
        return
      }
      const writes: Record<string, string> = { serverUrl }
      if (result.captureToken !== null) writes['token'] = result.captureToken
      if (result.serverToken !== null) writes['apiToken'] = result.serverToken
      await chrome.storage.local.set(writes)
      pairCodeEl.value = ''
      fillForm(await readSettings(chrome.storage.local))
      flash(
        result.captureToken === null
          ? 'Paired, but the server has no capture token configured — capture will stay disabled until it does.'
          : 'Paired. Tokens stored.',
      )
    } finally {
      pairEl.disabled = false
    }
  })()
})

// ---- outbox status -------------------------------------------------------

function asItems(raw: unknown): OutboxItem[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (i): i is OutboxItem =>
      i !== null && typeof i === 'object' && typeof (i as OutboxItem).idempotencyKey === 'string',
  )
}

async function refreshOutbox(): Promise<void> {
  const stored = await chrome.storage.local.get(['atento:outbox'])
  const items = asItems(stored['atento:outbox'])
  const live = items.filter((i) => i.dead !== true)
  const dead = items.filter((i) => i.dead === true)
  outboxStatsEl.textContent =
    live.length === 0 && dead.length === 0
      ? 'Outbox empty — every capture has been delivered.'
      : `${live.length} queued, ${dead.length} failed.`
  deadListEl.textContent = ''
  for (const item of dead.slice(0, 10)) {
    const line = document.createElement('p')
    line.className = 'dead'
    line.textContent = `${item.url} — ${item.lastError ?? 'failed'}`
    deadListEl.appendChild(line)
  }
  if (dead.length > 10) {
    const more = document.createElement('p')
    more.className = 'dead'
    more.textContent = `…and ${dead.length - 10} more`
    deadListEl.appendChild(more)
  }
  clearDeadEl.hidden = dead.length === 0
}

clearDeadEl?.addEventListener('click', () => {
  // Route through the service worker: its outbox instance owns the item
  // list in memory and would resurrect a direct storage write on the next
  // persist. clearDead drops the dead items and persists once.
  void chrome.runtime
    .sendMessage({ type: 'atento:outbox-clear-dead' })
    .then(() => refreshOutbox())
    .catch(() => flash('Could not reach the background worker; try again.'))
})

void refreshOutbox()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'atento:outbox' in changes) void refreshOutbox()
})
