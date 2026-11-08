import { writable } from 'svelte/store'

/**
 * Display density preference (A2). Persisted in localStorage — deliberately
 * NOT in URL state, so it stays a personal view preference rather than part
 * of a shareable link. Layout placement lives in urlState (?layout=) instead.
 */
export type Density = 'compact' | 'comfortable'

const KEY = 'linkinbox:density'

function read(): Density {
  try {
    return localStorage.getItem(KEY) === 'comfortable' ? 'comfortable' : 'compact'
  } catch {
    return 'compact'
  }
}

export const density = writable<Density>(
  typeof localStorage === 'undefined' ? 'compact' : read(),
)

export function setDensity(next: Density) {
  density.set(next)
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private mode */
  }
}
