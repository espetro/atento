/**
 * Small formatting helpers for tabular CLI output. No dependencies: the
 * shapes come from the ops layer and are rendered as-is.
 */

/** Render rows as a fixed-width table with a header. */
export function renderTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  )
  const line = (cells: (string | number | null | undefined)[]): string =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i]!)).join('  ')
  const head = line(headers)
  const divider = widths.map((w) => '-'.repeat(w)).join('  ')
  return [head, divider, ...rows.map(line)].join('\n')
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** Short ISO date for tables: 2026-10-29. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return ''
  return value.slice(0, 10)
}
