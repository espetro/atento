import type { Link } from '@atento/core'

export interface BuildPromptInput {
  link: Link
  /** Today's date, ISO. expires_at must be computed relative to this. */
  now?: Date
  /** Max characters of extracted content fed to the model. */
  contentMaxChars?: number
}

/** Build the system + user prompt pair for one structured-output call. */
export function buildPrompt(input: BuildPromptInput): {
  system: string
  user: string
} {
  const now = input.now ?? new Date()
  const today = now.toISOString().slice(0, 10)
  const contentMaxChars = input.contentMaxChars ?? 12000
  const { link } = input

  const system = [
    'You triage saved links for a personal reading inbox.',
    'Given a link with extracted content, return a JSON object with exactly these fields:',
    '- category: short lowercase label (e.g. "job", "event", "guide", "article", "video", "recipe")',
    '- priority: "low" | "normal" | "high"',
    '- why_it_matters: one sentence, why this is worth reading',
    '- read_minutes: integer estimate of minutes to read or watch',
    '- action: "read_now" | "schedule" | "archive" | "discard"',
    '- expires_at: ISO 8601 date-time string or null. The date the content stops being useful.',
    '  It MUST be computed relative to today, which is ' + today + '.',
    '  Use null for evergreen content (guides, reference docs, essays).',
    '- expiry_reason: short reason for the expiry (e.g. "job posting", "event over") or null',
    '- confidence: number between 0 and 1',
    '',
    'Rules:',
    '- Job postings expire in 30-60 days from today.',
    '- Events expire just after the event date; if the event already passed, action is "archive".',
    '- Deals, sales, deadlines expire at the stated deadline.',
    '- Evergreen content (guides, reference, essays) gets expires_at = null.',
    '- Return ONLY the JSON object, no markdown fences, no commentary.',
  ].join('\n')

  const content = (link.extractedContent ?? '').slice(0, contentMaxChars)
  const user = [
    'URL: ' + link.url,
    link.title ? 'Title: ' + link.title : null,
    link.addedAt ? 'Added at: ' + link.addedAt.toISOString() : null,
    'Today: ' + today,
    '',
    'Extracted content:',
    content || '(no content extracted)',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')

  return { system, user }
}
