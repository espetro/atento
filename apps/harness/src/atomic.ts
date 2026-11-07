/**
 * Atomic file writes: write to a sibling tmp file then rename, so readers
 * never observe a half-written pidfile/unit file. Same-directory rename is
 * atomic on POSIX filesystems.
 */
import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'

export function writeFileAtomicSync(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmpPath, content)
  renameSync(tmpPath, path)
}
