import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@atento/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@atento/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
      '@atento/extractors': fileURLToPath(new URL('../extractors/src/index.ts', import.meta.url)),
      '@atento/importers': fileURLToPath(new URL('../importers/src/index.ts', import.meta.url)),
      '@atento/media': fileURLToPath(new URL('../media/src/index.ts', import.meta.url)),
      '@atento/enrich': fileURLToPath(new URL('../enrich/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
