import { writable, get } from 'svelte/store'

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

/** Color theme preference: system | light | dark. Persists to localStorage;
    'system' follows prefers-color-scheme. Applied as .dark on <html>. */
export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'linkinbox:theme'

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export const theme = writable<Theme>(
  typeof localStorage === 'undefined' ? 'system' : readTheme(),
)

function apply(t: Theme) {
  const dark =
    t === 'dark' ||
    (t === 'system' &&
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function initTheme() {
  apply(get(theme))
  return theme.subscribe(apply)
}

export function setTheme(next: Theme) {
  theme.set(next)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* private mode */
  }
}
