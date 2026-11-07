/**
 * Atomic file writes: write to a temp file in the same directory, then
 * rename over the target. A crash can leave a stray `.tmp-*` file but never
 * a torn target — readers either see the old file or the new one.
 */
import { rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Write `data` to `path` atomically: temp file in the same directory +
 * rename. Same-filesystem rename is atomic on POSIX and Windows.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${randomBytes(6).toString('hex')}.tmp-${Date.now().toString(36)}`,
  )
  await writeFile(tmp, data)
  await rename(tmp, path)
}
