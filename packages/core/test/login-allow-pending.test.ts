import { describe, expect, it } from 'vitest'
import { FakeStore } from './fake-store.js'
import { listHostsNeedingLogin } from '../src/index.js'
import { normalizeUrl } from '../src/url.js'

async function parkAsShell(store: FakeStore, url: string, host: string): Promise<void> {
  const { url: normalized, hash } = normalizeUrl(url)
  const link = await store.upsertLink({
    urlHash: hash,
    url: normalized,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
  })
  await store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date(0).toISOString() })
  await store.applyEvent(link.id, {
    type: 'NEEDS_BROWSER',
    host,
    reason: 'js_shell',
    at: new Date(0).toISOString(),
  } as never)
}

describe('listHostsNeedingLogin: allow-listed hosts', () => {
  it('lists an allowed host parked as a shell page, but not an unlisted one', async () => {
    const store = new FakeStore()
    await parkAsShell(store, 'https://app.devin.ai/s/1', 'app.devin.ai')
    await parkAsShell(store, 'https://random.example/p', 'random.example')
    const hosts = await listHostsNeedingLogin(store, { loginAllow: ['app.devin.ai'] })
    expect(hosts.map((h) => h.host)).toEqual(['app.devin.ai'])
  })
})
