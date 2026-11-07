import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@linkinbox/app': fileURLToPath(new URL('../../packages/app/src/index.ts', import.meta.url)),
      '@linkinbox/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@linkinbox/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@linkinbox/mcp': fileURLToPath(new URL('../../packages/mcp/src/index.ts', import.meta.url)),
      '@linkinbox/server': fileURLToPath(new URL('../../packages/server/src/index.ts', import.meta.url)),
      '@linkinbox/extractors': fileURLToPath(new URL('../../packages/extractors/src/index.ts', import.meta.url)),
      '@linkinbox/importers': fileURLToPath(new URL('../../packages/importers/src/index.ts', import.meta.url)),
      '@linkinbox/media': fileURLToPath(new URL('../../packages/media/src/index.ts', import.meta.url)),
      '@linkinbox/enrich': fileURLToPath(new URL('../../packages/enrich/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
