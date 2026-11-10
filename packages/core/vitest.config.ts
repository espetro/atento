import { defineConfig } from 'vitest/config'

// Pacing tests use fixed instants that assume a fixed local zone (working-hours window).
process.env.TZ = 'America/Los_Angeles'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
