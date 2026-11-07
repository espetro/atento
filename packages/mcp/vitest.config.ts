import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@linkinbox/app': fileURLToPath(new URL('../app/src/index.ts', import.meta.url)),
      '@linkinbox/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@linkinbox/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
      '@linkinbox/extractors': fileURLToPath(new URL('../extractors/src/index.ts', import.meta.url)),
      '@linkinbox/importers': fileURLToPath(new URL('../importers/src/index.ts', import.meta.url)),
      '@linkinbox/media': fileURLToPath(new URL('../media/src/index.ts', import.meta.url)),
      '@linkinbox/enrich': fileURLToPath(new URL('../enrich/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
