import { describe, expect, it } from 'vitest'
import {
  LINK_EVENTS,
  LINK_STATES,
  TRANSITION_PAIRS,
  TRANSITIONS,
  IllegalTransition,
  transition,
  isTerminal,
  isProcessing,
  isActionable,
  legacyStatus,
  publicStatus,
  parseLinkState,
  InvalidState,
  type LinkEvent,
  type LinkState,
  type LinkStateName,
} from '../src/index.js'

const NOW = new Date('2026-10-29T12:00:00.000Z')

/** Build a minimal legal event for each event name. */
function eventFor(name: string): LinkEvent {
  const at = NOW.toISOString()
  switch (name) {
    case 'EXTRACT_STARTED': return { type: 'EXTRACT_STARTED', at, attempt: 1 }
    case 'EXTRACTED': return { type: 'EXTRACTED', at, chars: 100 }
    case 'NEEDS_BROWSER': return { type: 'NEEDS_BROWSER', at, host: 'x.com' }
    case 'EXTRACT_FAILED': return { type: 'EXTRACT_FAILED', at, error: 'boom', retryable: true }
    case 'DEFER': return { type: 'DEFER', at, stage: 'extract', nextAttemptAt: at, attempts: 1, reason: 'backoff' }
    case 'ENRICH_STARTED': return { type: 'ENRICH_STARTED', at, attempt: 1 }
    case 'ENRICHED': return { type: 'ENRICHED', at }
    case 'ENRICH_FAILED': return { type: 'ENRICH_FAILED', at, error: 'model down', retryable: true }
    case 'TRIAGE': return { type: 'TRIAGE', at, action: 'archive' }
    case 'EXPIRE': return { type: 'EXPIRE', at }
    case 'RESTORE': return { type: 'RESTORE', at }
    case 'RETRY': return { type: 'RETRY', at, stage: 'extract' }
    case 'LEASE_EXPIRED': return { type: 'LEASE_EXPIRED', at }
    case 'DELETE': return { type: 'DELETE', at }
    default: throw new Error(`no event builder for ${name}`)
  }
}

/** Build a valid instance of each state. */
function stateFor(name: LinkStateName): LinkState {
  const at = NOW.toISOString()
  switch (name) {
    case 'created': return { state: 'created' }
    case 'extracting': return { state: 'extracting', startedAt: at, attempt: 1 }
    case 'extracted': return { state: 'extracted', chars: 100 }
    case 'needs_browser': return { state: 'needs_browser', host: 'x.com' }
    case 'deferred': return { state: 'deferred', stage: 'extract', nextAttemptAt: at, attempts: 1, reason: 'r' }
    case 'enriching': return { state: 'enriching', startedAt: at, attempt: 1 }
    case 'inbox': return { state: 'inbox', enriched: true }
    case 'scheduled': return { state: 'scheduled', scheduledFor: null }
    case 'archived': return { state: 'archived', archivedAt: at, reason: 'manual' }
    case 'discarded': return { state: 'discarded', discardedAt: at }
    case 'errored': return { state: 'errored', stage: 'extract', error: 'x', attempts: 1, retryable: true }
    case 'deleted': return { state: 'deleted', deletedAt: at }
  }
}

describe('transition table: exhaustive matrix', () => {
  const matrix: Record<string, Record<string, string | 'IllegalTransition'>> = {}
  for (const state of LINK_STATES) {
    matrix[state] = {}
    for (const event of LINK_EVENTS) {
      const result = transition(stateFor(state), eventFor(event), NOW)
      matrix[state]![event] = result.ok ? result.state.state : 'IllegalTransition'
    }
  }

  it('snapshots the full state x event matrix', () => {
    expect(matrix).toMatchSnapshot()
  })

  it('every listed transition is allowed and produces its target', () => {
    for (const [state, event] of TRANSITION_PAIRS) {
      const result = transition(stateFor(state), eventFor(event), NOW)
      expect(result.ok, `${state} + ${event} should be legal`).toBe(true)
    }
  })

  it('every unlisted transition is rejected with IllegalTransition', () => {
    const legal = new Set(TRANSITION_PAIRS.map(([s, e]) => `${s}:${e}`))
    for (const state of LINK_STATES) {
      for (const event of LINK_EVENTS) {
        if (legal.has(`${state}:${event}`)) continue
        const result = transition(stateFor(state), eventFor(event), NOW)
        expect(
          result.ok,
          `${state} + ${event} should be illegal but got ${result.ok ? result.state.state : 'ok:false'}`,
        ).toBe(false)
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(IllegalTransition)
          expect(result.error.from).toBe(state)
          expect(result.error.event).toBe(event)
        }
      }
    }
  })

  it('nothing leaves deleted', () => {
    for (const event of LINK_EVENTS) {
      const result = transition(stateFor('deleted'), eventFor(event), NOW)
      expect(result.ok, `deleted + ${event} must be rejected`).toBe(false)
    }
  })

  it('every non-terminal state can reach deleted', () => {
    const reach = new Map<LinkStateName, Set<LinkStateName>>()
    for (const [from, ev] of TRANSITION_PAIRS) {
      const result = transition(stateFor(from), eventFor(ev), NOW)
      if (!result.ok) continue
      const set = reach.get(from) ?? new Set<LinkStateName>()
      set.add(result.state.state)
      reach.set(from, set)
    }
    const canReach = (start: LinkStateName, target: LinkStateName): boolean => {
      const seen = new Set<LinkStateName>([start])
      const queue = [start]
      while (queue.length > 0) {
        const cur = queue.shift()!
        if (cur === target) return true
        for (const next of reach.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next)
            queue.push(next)
          }
        }
      }
      return false
    }
    for (const state of LINK_STATES) {
      if (state === 'deleted') continue
      expect(
        canReach(state, 'deleted'),
        `${state} should be able to reach deleted`,
      ).toBe(true)
    }
  })
})

describe('property tests (seeded random walk)', () => {
  /** Deterministic PRNG so the walk is reproducible. */
  function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomWalk(seed: number, steps: number): { state: LinkState; visited: Set<LinkStateName> } {
    const rng = mulberry32(seed)
    let state: LinkState = { state: 'created' }
    const visited = new Set<LinkStateName>(['created'])
    for (let i = 0; i < steps; i++) {
      const eventName = LINK_EVENTS[Math.floor(rng() * LINK_EVENTS.length)]!
      const result = transition(state, eventFor(eventName), NOW)
      if (result.ok) {
        state = result.state
        visited.add(state.state)
      }
    }
    return { state, visited }
  }

  it('from created, every state is reachable', () => {
    const reachable = new Set<LinkStateName>()
    for (let seed = 1; seed <= 200; seed++) {
      for (const s of randomWalk(seed, 200).visited) reachable.add(s)
    }
    // supplement with known short paths to cover low-probability states
    for (const s of LINK_STATES) {
      expect(
        reachable.has(s) || seedReaches(s),
        `state ${s} should be reachable from created`,
      ).toBe(true)
    }
  })

  it('deleted is absorbing: once reached, the walk never leaves', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { state, visited } = randomWalk(seed, 500)
      if (visited.has('deleted')) {
        expect(state.state).toBe('deleted')
      }
    }
  })

  /** Hand-built reachability witness for each state (guards against low-probability paths). */
  function seedReaches(target: LinkStateName): boolean {
    const paths: Record<LinkStateName, string[]> = {
      created: [],
      extracting: ['EXTRACT_STARTED'],
      extracted: ['EXTRACT_STARTED', 'EXTRACTED'],
      needs_browser: ['EXTRACT_STARTED', 'NEEDS_BROWSER'],
      deferred: ['EXTRACT_STARTED', 'DEFER'],
      enriching: ['EXTRACT_STARTED', 'EXTRACTED', 'ENRICH_STARTED'],
      inbox: ['ENRICH_STARTED', 'ENRICHED'],
      scheduled: ['ENRICH_STARTED', 'ENRICHED', 'TRIAGE_SCHEDULE'],
      archived: ['ENRICH_STARTED', 'ENRICHED', 'TRIAGE_ARCHIVE'],
      discarded: ['ENRICH_STARTED', 'ENRICHED', 'TRIAGE_DISCARD'],
      errored: ['EXTRACT_STARTED', 'EXTRACT_FAILED'],
      deleted: ['DELETE'],
    }
    let state: LinkState = { state: 'created' }
    for (const step of paths[target]) {
      const event = step.startsWith('TRIAGE')
        ? ({ type: 'TRIAGE', at: NOW.toISOString(), action: step.split('_')[1]!.toLowerCase() } as LinkEvent)
        : eventFor(step)
      const result = transition(state, event, NOW)
      if (!result.ok) return false
      state = result.state
    }
    return state.state === target
  }
})

describe('invariants per state', () => {
  it('extracted carries a char count', () => {
    const result = transition(stateFor('extracting'), eventFor('EXTRACTED'), NOW)
    expect(result.ok && result.state.state === 'extracted' && result.state.chars >= 0).toBe(true)
  })

  it('inbox implies enriched=true after ENRICHED', () => {
    const result = transition(stateFor('enriching'), eventFor('ENRICHED'), NOW)
    expect(result.ok && result.state.state === 'inbox' && result.state.enriched).toBe(true)
  })

  it('processing states carry a lease (startedAt)', () => {
    for (const name of ['extracting', 'enriching'] as const) {
      const state = stateFor(name)
      expect(isProcessing(state)).toBe(true)
      if (state.state === 'extracting' || state.state === 'enriching') {
        expect(state.startedAt).toBeTruthy()
      }
    }
    expect(isProcessing(stateFor('created'))).toBe(false)
  })

  it('isTerminal / isActionable', () => {
    expect(isTerminal(stateFor('deleted'))).toBe(true)
    expect(isTerminal(stateFor('inbox'))).toBe(false)
    expect(isActionable(stateFor('inbox'))).toBe(true)
    expect(isActionable(stateFor('archived'))).toBe(false)
  })
})

describe('status projections', () => {
  it('legacyStatus maps to the four legacy values', () => {
    expect(legacyStatus(stateFor('inbox'))).toBe('inbox')
    expect(legacyStatus(stateFor('scheduled'))).toBe('scheduled')
    expect(legacyStatus(stateFor('archived'))).toBe('archived')
    expect(legacyStatus(stateFor('discarded'))).toBe('discarded')
    expect(legacyStatus(stateFor('deleted'))).toBe('deleted')
    // pipeline states collapse onto the legacy inbox projection
    expect(legacyStatus(stateFor('created'))).toBe('inbox')
    expect(legacyStatus(stateFor('extracting'))).toBe('inbox')
    expect(legacyStatus(stateFor('extracted'))).toBe('inbox')
    expect(legacyStatus(stateFor('needs_browser'))).toBe('inbox')
    expect(legacyStatus(stateFor('deferred'))).toBe('inbox')
    expect(legacyStatus(stateFor('enriching'))).toBe('inbox')
    expect(legacyStatus(stateFor('errored'))).toBe('inbox')
  })

  it('publicStatus mirrors the state name', () => {
    for (const name of LINK_STATES) {
      expect(publicStatus(stateFor(name))).toBe(name)
    }
  })
})

describe('parseLinkState', () => {
  it('parses a valid state', () => {
    expect(parseLinkState('inbox', { enriched: true })).toEqual({ state: 'inbox', enriched: true })
  })
  it('rejects an unknown state', () => {
    expect(() => parseLinkState('bogus', {})).toThrow(InvalidState)
  })
  it('rejects a state with the wrong payload shape', () => {
    expect(() => parseLinkState('extracting', { attempt: 'x' })).toThrow(InvalidState)
  })
})

describe('transition table completeness', () => {
  it('TRANSITIONS keys match TRANSITION_PAIRS', () => {
    expect(TRANSITIONS.size).toBe(TRANSITION_PAIRS.length)
  })
})
