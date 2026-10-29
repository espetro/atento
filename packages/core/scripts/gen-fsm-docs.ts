/**
 * Generates the mermaid state diagram for docs/fsm.md from the transition
 * table, so the document can never drift from the code.
 *
 *   pnpm --filter @linkinbox/core gen:fsm-docs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  LINK_EVENTS,
  LINK_STATES,
  TRANSITION_PAIRS,
  transition,
  transitionTable,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const docsDir = join(repoRoot, 'docs')

/** A minimal valid instance of each state. */
function stateFor(name: string): { state: string } {
  const at = new Date(0).toISOString()
  switch (name) {
    case 'created': return { state: 'created' }
    case 'extracting': return { state: 'extracting', startedAt: at, attempt: 1 }
    case 'extracted': return { state: 'extracted', chars: 1 }
    case 'needs_browser': return { state: 'needs_browser', host: 'x' }
    case 'deferred': return { state: 'deferred', stage: 'extract', nextAttemptAt: at, attempts: 1, reason: 'r' }
    case 'enriching': return { state: 'enriching', startedAt: at, attempt: 1 }
    case 'inbox': return { state: 'inbox', enriched: true }
    case 'scheduled': return { state: 'scheduled', scheduledFor: null }
    case 'archived': return { state: 'archived', archivedAt: at, reason: 'manual' }
    case 'discarded': return { state: 'discarded', discardedAt: at }
    case 'errored': return { state: 'errored', stage: 'extract', error: 'x', attempts: 1, retryable: true }
    case 'deleted': return { state: 'deleted', deletedAt: at }
    default: throw new Error(`unknown state ${name}`)
  }
}

/** A minimal valid instance of each event. */
function eventFor(name: string): { type: string; at: string } {
  const at = new Date(0).toISOString()
  switch (name) {
    case 'EXTRACT_STARTED': return { type: 'EXTRACT_STARTED', at, attempt: 1 }
    case 'EXTRACTED': return { type: 'EXTRACTED', at, chars: 1 }
    case 'NEEDS_BROWSER': return { type: 'NEEDS_BROWSER', at, host: 'x' }
    case 'EXTRACT_FAILED': return { type: 'EXTRACT_FAILED', at, error: 'x' }
    case 'DEFER': return { type: 'DEFER', at, stage: 'extract', nextAttemptAt: at, attempts: 1, reason: 'r' }
    case 'ENRICH_STARTED': return { type: 'ENRICH_STARTED', at, attempt: 1 }
    case 'ENRICHED': return { type: 'ENRICHED', at }
    case 'ENRICH_FAILED': return { type: 'ENRICH_FAILED', at, error: 'x' }
    case 'TRIAGE': return { type: 'TRIAGE', at, action: 'archive' }
    case 'EXPIRE': return { type: 'EXPIRE', at }
    case 'RESTORE': return { type: 'RESTORE', at }
    case 'RETRY': return { type: 'RETRY', at, stage: 'extract' }
    case 'LEASE_EXPIRED': return { type: 'LEASE_EXPIRED', at }
    case 'DELETE': return { type: 'DELETE', at }
    default: throw new Error(`unknown event ${name}`)
  }
}

/** The mermaid source for the transition table. */
export function renderDiagram(): string {
  const table = transitionTable()
  const lines: string[] = ['stateDiagram-v2']
  for (const state of LINK_STATES) {
    lines.push(`    ${state}`)
  }
  for (const [state, handlers] of Object.entries(table)) {
    for (const event of handlers) {
      const result = transition(
        stateFor(state),
        eventFor(event),
      )
      const target = result.ok ? result.state.state : state
      lines.push(`    ${state} --> ${target}: ${event}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** The whole document. */
export function renderDoc(): string {
  const table = transitionTable()
  const rows: string[] = []
  for (const state of LINK_STATES) {
    const events = table[state] ?? []
    rows.push(`| \`${state}\` | ${events.length} | ${events.map((e) => `\`${e}\``).join(', ') || '(terminal)'} |`)
  }
  return `# The linkinbox state machine


Every persisted link sits in exactly one state. The state is stored as the discriminant \`links.state\` plus the variant payload \`links.state_data\`, and it is the only source of truth for the status of an item. The legacy \`links.status\` column is a projection of the state, not an independent field.

## States

| State | Meaning |
| --- | --- |
| \`created\` | The link is queued for extraction. |
| \`extracting\` | A runner holds a lease on the link and is extracting. |
| \`extracted\` | Content is stored, the link waits for enrichment. |
| \`needs_browser\` | Extraction could not run locally, a browser is needed. |
| \`deferred\` | Waiting on a rate limit, a backoff or an open breaker. |
| \`enriching\` | A runner holds a lease on the link and is enriching. |
| \`inbox\` | Enriched and awaiting triage. |
| \`scheduled\` | Triaged to be read later. |
| \`archived\` | Parked, either by the user or because it expired. |
| \`discarded\` | Explicitly thrown away by the user. |
| \`errored\` | A stage failed, the link carries the error and the attempts. |
| \`deleted\` | Terminal tombstone. Nothing leaves this state. |

The processing states \`extracting\` and \`enriching\` carry a lease, a \`startedAt\` timestamp. A \`LEASE_EXPIRED\` event returns a stranded item to its queue, so a killed process never strands a link.

## Events

| Event | Payload |
| --- | --- |
| \`EXTRACT_STARTED\` | \`attempt\` |
| \`EXTRACTED\` | \`chars\` |
| \`NEEDS_BROWSER\` | \`host\` |
| \`EXTRACT_FAILED\` | \`error\`, \`retryable\`, \`attempts\` |
| \`DEFER\` | \`stage\`, \`nextAttemptAt\`, \`attempts\`, \`reason\` |
| \`ENRICH_STARTED\` | \`attempt\` |
| \`ENRICHED\` | none |
| \`ENRICH_FAILED\` | \`error\`, \`retryable\`, \`attempts\` |
| \`TRIAGE\` | \`action\`, \`scheduledFor\` |
| \`EXPIRE\` | none |
| \`RESTORE\` | none |
| \`RETRY\` | \`stage\` |
| \`LEASE_EXPIRED\` | none |
| \`DELETE\` | none |

## Transition table

| State | Legal events |
| --- | --- |
${rows.join('\n')}

## Diagram

\`\`\`mermaid
${renderDiagram().trimEnd()}
\`\`\`

## Reading the state

\`\`\`ts
import { transition, publicStatus, legacyStatus } from '@linkinbox/core'

const result = transition(state, event)
if (result.ok) {
  console.log(result.state.state)      // the fine grained state
  console.log(publicStatus(result.state))  // the public status projection
} else {
  console.log(result.error.code)      // ILLEGAL_TRANSITION
}
\`\`\`

The store applies events with an atomic compare-and-set, so two runners can never take the same link:

\`\`\`ts
const claimed = await store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() }, 'created')
if (!claimed.ok) {
  // claimed.error.code is STALE_STATE when another runner won the race
}
\`\`\`

Every applied event is appended to the \`link_events\` table in the same transaction as the state change, so the history is complete and append-only.

## Deleted is a tombstone

\`prune --apply\` does not remove the row. It moves the link to \`deleted\`, purges \`extracted_content\` and \`enrichment\`, and keeps \`url_hash\`. Re-importing the same URL is therefore a no-op and can never resurrect a pruned link. This refines the plan wording, which described prune as a hard delete.

\`restore\` moves \`archived\`, \`discarded\` and \`errored\` links back to the inbox. It never resurrects a \`deleted\` link.

## Backwards compatibility

The \`status\` field of the API is unchanged. It is the \`legacyStatus\` projection of the state, one of \`inbox\`, \`scheduled\`, \`archived\`, \`discarded\` or \`deleted\`. Pipeline states project onto \`inbox\`, which is what the old code expected from a link that had not been triaged yet. \`linkinbox list --state <state>\` filters on the fine grained state.
`
}

// Only write when run directly, so importing the module is side effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(docsDir, 'fsm.md'), renderDoc())
  console.log('wrote docs/fsm.md')
  console.log(`${TRANSITION_PAIRS.length} transitions, ${LINK_EVENTS.length} events`)
}
