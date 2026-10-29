import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Read a file, returning null (plus a warning) instead of throwing. */
export async function readTextFile(
  filePath: string,
): Promise<{ text: string | null; warning: string | null }> {
  try {
    const text = await readFile(filePath, 'utf8')
    return { text, warning: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return {
        text: null,
        warning: `Cannot read ${filePath}: permission denied (${e.code}). Grant Full Disk Access to the terminal in System Settings -> Privacy & Security -> Full Disk Access.`,
      }
    }
    if (e.code === 'ENOENT') {
      return { text: null, warning: `Cannot read ${filePath}: file not found.` }
    }
    return { text: null, warning: `Cannot read ${filePath}: ${e.message}` }
  }
}

/** Lowercased extension without the dot, '' when there is none. */
export function extensionOf(filePath: string): string {
  return extname(filePath).replace(/^\./, '').toLowerCase()
}
