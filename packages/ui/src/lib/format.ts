/** Small display helpers shared by the views. */
import { m } from '../paraglide/messages.js'

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

// Path segments that never make a useful headline.
const TITLE_STOP_SEGMENTS = new Set([
  'index',
  'home',
  'status',
  'statuses',
  'tweet',
  'post',
  'photo',
  'video',
  'watch',
  'about',
  'login',
  'signin',
  'signup',
  'tag',
  'topic',
  'search',
])

/**
 * Best-effort readable title derived from the URL path, used when a link has
 * neither a summary nor an extracted title. Falls back to the bare hostname
 * when no path segment looks like a slug, and to the raw url if it does not
 * parse at all.
 */
export function renderTitle(url: string): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    for (let i = segs.length - 1; i >= 0; i--) {
      let seg = segs[i]!
      try {
        seg = decodeURIComponent(seg)
      } catch {
        // malformed escape — keep the raw segment
      }
      const stem = seg.replace(/\.(?:html?|php|aspx?|jsp)$/i, '')
      if (!/[a-zA-Z]/.test(stem)) continue
      if (/^\d+$/.test(stem) || TITLE_STOP_SEGMENTS.has(stem.toLowerCase())) continue
      const pretty = stem
        .replace(/[-_+.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (pretty.length < 2) continue
      return pretty.replace(/\b\w/g, (c) => c.toUpperCase())
    }
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Relative-ish timestamp: "just now", "5m ago", "in 4m", "2h ago", "3d ago", else a date. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  const future = diff < 0
  const abs = Math.abs(diff)
  let text: string
  if (abs < 45_000) return m.time_just_now()
  const mins = Math.floor(abs / 60_000)
  if (mins < 60) text = `${mins}m`
  else {
    const h = Math.floor(mins / 60)
    if (h < 48) text = `${h}h`
    else {
      const d = Math.floor(h / 24)
      text = d < 30 ? `${d}d` : new Date(t).toLocaleDateString()
    }
  }
  if (text.includes('/') || text.includes('.')) return text
  return future ? m.time_in_future({ text }) : m.time_ago({ text })
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd == null) return '—'
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API unavailable (insecure context): fall back to execCommand.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      return true
    } catch {
      return false
    }
  }
}
