import type { LinkEvent, LinkEventName } from './events.js'
import { TRANSITIONS } from './table.js'
import type { LinkState, LinkStateName } from './states.js'

/**
 * The pure transition function plus its result types.
 */

export class IllegalTransition extends Error {
  readonly code = 'ILLEGAL_TRANSITION' as const
  constructor(
    readonly from: LinkStateName,
    readonly event: LinkEventName,
    message?: string,
  ) {
    super(message ?? `illegal transition: ${event} is not allowed from ${from}`)
    this.name = 'IllegalTransition'
  }
}

export type TransitionResult =
  | { ok: true; state: LinkState; from: LinkStateName; event: LinkEventName }
  | { ok: false; error: IllegalTransition }

/**
 * Apply one event to one state. Pure: never touches storage. Returns a typed
 * result; callers decide whether an illegal transition is fatal.
 */
export function transition(
  state: LinkState,
  event: LinkEvent,
  at: Date = new Date(),
): TransitionResult {
  const handler = TRANSITIONS.get(`${state.state}:${event.type}`)
  if (!handler) {
    return { ok: false, error: new IllegalTransition(state.state, event.type) }
  }
  return { ok: true, state: handler(state, event, at), from: state.state, event: event.type }
}
