import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@atento/app': fileURLToPath(new URL('../../packages/app/src/index.ts', import.meta.url)),
      '@atento/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@atento/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@atento/mcp': fileURLToPath(new URL('../../packages/mcp/src/index.ts', import.meta.url)),
      '@atento/server': fileURLToPath(new URL('../../packages/server/src/index.ts', import.meta.url)),
      '@atento/extractors': fileURLToPath(new URL('../../packages/extractors/src/index.ts', import.meta.url)),
      '@atento/importers': fileURLToPath(new URL('../../packages/importers/src/index.ts', import.meta.url)),
      '@atento/media': fileURLToPath(new URL('../../packages/media/src/index.ts', import.meta.url)),
      '@atento/enrich': fileURLToPath(new URL('../../packages/enrich/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
