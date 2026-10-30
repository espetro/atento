// Options page wiring: token, server URL and source identity in
// chrome.storage.local. Never logged, never synced.
const fields = ['endpoint', 'token', 'source'] as const

const statusEl = document.getElementById('status') as HTMLParagraphElement
const originEl = document.getElementById('origin') as HTMLParagraphElement

originEl.textContent = `This extension's origin: ${chrome.runtime.getURL('').replace(/\/$/, '')}`

void chrome.storage.local.get([...fields]).then((stored) => {
  for (const name of fields) {
    const el = document.getElementById(name) as HTMLInputElement
    const value = stored[name]
    if (typeof value === 'string') el.value = value
  }
})

document.getElementById('save')?.addEventListener('click', () => {
  const values: Record<string, string> = {}
  for (const name of fields) {
    const el = document.getElementById(name) as HTMLInputElement
    values[name] = el.value.trim()
  }
  void chrome.storage.local.set(values).then(() => {
    statusEl.textContent = 'Saved.'
    void setTimeout(() => {
      statusEl.textContent = ''
    }, 2000)
  })
})
