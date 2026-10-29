import { parse as parseToml } from 'smol-toml'
import { ttlFromToml, type TtlConfig, type TomlTable } from './ttl.js'

/**
 * Parse the `[ttl]` table out of raw TOML text. The only TOML the pipeline
 * needs today is the ttl table, but the full document parses so other config
 * sections can live in the same file.
 */
export function parseTtlConfig(tomlText: string): TtlConfig {
  return ttlFromToml(parseToml(tomlText) as TomlTable)
}
