/**
 * Capture safety rules, enforced before anything is sent.
 *
 * Four rules from docs/extension.md: never capture private windows,
 * never capture banking-like hosts, never capture hosts the user denied,
 * never capture privileged browser pages. All four are pure functions over
 * a tab snapshot and a deny list, so the tests need no browser.
 *
 * The extension never sends cookies and never asks for the cookies
 * permission; that rule is structural (what the manifest requests), so it
 * has no function here.
 */

/** How a deny pattern matches a host: exact host, or *.suffix wildcard. */
export interface DenyPattern {
  /** Exact host ("privatebank.com") or a wildcard ("*.privatebank.com"). */
  pattern: string
  /** Why the host is denied, shown in the popup. */
  reason: string
}

/**
 * The seeded deny list: categories, not specific sites. The pipeline's own
 * skip_hosts config uses the same exact-or-wildcard matching, but the
 * extension cannot read the server's config file, so it keeps its own copy
 * and the user can extend it in the options page.
 */
export const DEFAULT_DENY_LIST: DenyPattern[] = [
  { pattern: '*.bank', reason: 'banking' },
  { pattern: '*.banking', reason: 'banking' },
  { pattern: '*.creditcard', reason: 'banking' },
  { pattern: 'paypal.com', reason: 'payments' },
  { pattern: '*.paypal.com', reason: 'payments' },
  { pattern: 'stripe.com', reason: 'payments' },
  { pattern: '*.stripe.com', reason: 'payments' },
  { pattern: 'wise.com', reason: 'payments' },
  { pattern: '*.wise.com', reason: 'payments' },
  { pattern: '1password.com', reason: 'password manager' },
  { pattern: '*.1password.com', reason: 'password manager' },
  { pattern: 'bitwarden.com', reason: 'password manager' },
  { pattern: '*.bitwarden.com', reason: 'password manager' },
]

/** URL schemes the browser owns. Never captured. */
const PRIVILEGED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'edge:',
  'about:',
  'devtools:',
  'view-source:',
  'moz-extension:',
  'safari-extension:',
  'browser-extension:',
  'file:',
  'data:',
  'blob:',
  'javascript:',
] as const

/** The decision for one tab. */
export interface CaptureDecision {
  allowed: boolean
  /** Why the tab was denied, for the popup. Null when allowed. */
  reason: string | null
}

/**
 * Exact host match, or a *.suffix wildcard (the wildcard matches the bare
 * suffix too: *.bank matches bank.example and also a host named bank).
 */
export function matchesDenyPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase()
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) {
    const suffix = p.slice(2)
    return h === suffix || h.endsWith('.' + suffix)
  }
  return h === p
}

/** True when the URL is a browser-owned page the extension must never read. */
export function isPrivilegedUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const scheme = parsed.protocol
  return (PRIVILEGED_SCHEMES as readonly string[]).some((s) => scheme === s || scheme === s + ':')
}

/**
 * The capture decision for one tab: privileged scheme, the effective deny
 * list (defaults plus the user's own entries), and nothing else. The
 * incognito check lives in the caller because it is not derivable from the
 * URL alone.
 */
export function decideCapture(
  url: string,
  denyList: DenyPattern[] = DEFAULT_DENY_LIST,
): CaptureDecision {
  if (isPrivilegedUrl(url)) {
    return { allowed: false, reason: 'privileged page' }
  }
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return { allowed: false, reason: 'unparsable url' }
  }
  if (host === '') return { allowed: false, reason: 'no host' }
  for (const entry of denyList) {
    if (matchesDenyPattern(host, entry.pattern)) {
      return { allowed: false, reason: entry.reason }
    }
  }
  return { allowed: true, reason: null }
}
