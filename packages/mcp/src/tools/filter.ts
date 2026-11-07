/** CLI batch filter syntax over projected rows: `status:archived category:job stale:1`. */
export function applyFilter(
  rows: Record<string, unknown>[],
  filter?: string,
): Record<string, unknown>[] {
  if (!filter) return rows
  const clauses = filter
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
  return rows.filter((row) =>
    clauses.every((clause) => {
      const [key, raw] = clause.includes(':') ? clause.split(/:(.+)/) : [clause, '']
      const value = raw ?? ''
      switch (key) {
        case 'status':
          return row['status'] === value
        case 'category':
          return row['category'] === value
        case 'stale':
          return value === '' || value === '1' || value === 'true'
        default:
          return String(row['title'] ?? '').toLowerCase().includes(clause.toLowerCase())
      }
    }),
  )
}
