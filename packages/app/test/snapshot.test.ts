import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSnapshotter } from '../src/snapshot.js'

describe('snapshotter', () => {
  it('rejects non-http urls and reads null when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snap-'))
    const s = createSnapshotter(dir, (u) => Buffer.from(u).toString('hex'))
    expect(await s.request('file:///etc/passwd')).toBe('unavailable')
    expect(await s.read('https://example.com/')).toBeNull()
  })
})
