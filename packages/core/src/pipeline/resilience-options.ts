/** Shared pipeline resilience option defaults. */
/** Max DEFER rounds before a link moves to errored via the FSM. */
export const DEFAULT_MAX_ATTEMPTS = 5

/**
 * A limits config with no throttling at all (the CLI tests inject this so a
 * fixture run is not deferred by the production spacing rules). `disabled`
 * makes the pipeline skip the guard entirely.
 */
export const UNLIMITED_LIMITS = {
  disabled: true,
  globalConcurrency: 1000,
  maxBatch: 1000,
  llmConcurrency: 1000,
  walledGardens: [] as string[],
  skipHosts: [] as string[],
  hosts: {},
}
