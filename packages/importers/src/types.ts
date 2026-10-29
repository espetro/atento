import type { RawLink } from '@linkinbox/core'

/**
 * Result of an import attempt. Importers never throw on bad input: they
 * return what they could parse plus warnings describing what went wrong.
 */
export interface ImportResult {
  links: RawLink[]
  warnings: string[]
}

export interface Importer {
  /** Stable importer name, used as `RawLink.source`. */
  name: string
  /** Whether this importer can handle the given file. */
  matches(filePath: string): boolean
  /** Parse a file into raw links. Never throws. */
  import(filePath: string): Promise<ImportResult>
}
