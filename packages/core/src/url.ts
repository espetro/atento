import { createHash } from 'node:crypto'

/**
 * Query params stripped before hashing/dedup. `utm_*` covers utm_source,
 * utm_campaign, utm_content, ... by prefix.
 */
const STRIP_PREFIXES = ['utm_']
const STRIP_EXACT = new Set(['fbclid', 'ref', 'gclid', 'mc_cid', 'mc_eit'])

export interface NormalizedUrl {
  /** Normalized URL string. */
  url: string
  /** sha256 of the normalized URL; the dedupe key. */
  hash: string
}

/**
 * Normalize a URL for dedupe: lowercase scheme/host, drop default port,
 * strip tracking params (`utm_*`, `fbclid`, `ref`, ...), remove trailing
 * slash on the path, drop empty fragment. Pure.
 */
export function normalizeUrl(input: string): NormalizedUrl {
  const trimmed = input.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    // Not a parseable absolute URL: hash the raw string so callers still get
    // a stable dedupe key instead of crashing.
    const url = trimmed.replace(/\/+$/, '')
    return { url, hash: sha256(url) }
  }

  parsed.protocol = parsed.protocol.toLowerCase()
  if (parsed.protocol === 'http:') parsed.protocol = 'http:'
  parsed.hostname = parsed.hostname.toLowerCase()
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = ''
  }

  // Strip tracking params, preserving order of the rest.
  const drop: string[] = []
  for (const key of new Set(parsed.searchParams.keys())) {
    const lower = key.toLowerCase()
    if (STRIP_EXACT.has(lower) || STRIP_PREFIXES.some((p) => lower.startsWith(p))) {
      drop.push(key)
    }
  }
  for (const key of drop) parsed.searchParams.delete(key)
  if (parsed.search === '?') parsed.search = ''
  // searchParams.delete collapses `?` only when empty; normalize explicit empty.
  if (parsed.searchParams.size === 0) parsed.search = ''

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  }
  if (parsed.hash === '#') parsed.hash = ''

  const url = parsed.toString()
  return { url, hash: sha256(url) }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}
