import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@linkinbox/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
      '@linkinbox/extractors': fileURLToPath(
        new URL('../packages/extractors/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
