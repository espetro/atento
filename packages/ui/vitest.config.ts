import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import Icons from 'unplugin-icons/vite'

export default defineConfig({
  plugins: [svelte({ hot: false }), Icons({ compiler: 'svelte' })],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
  resolve: {
    conditions: ['browser'],
  },
})
