import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import Icons from 'unplugin-icons/vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { mockApiPlugin } from './src/mock/plugin.js'
import path from 'node:path'

const mock = process.env.VITE_MOCK === '1'

export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte(),
    Icons({ compiler: 'svelte' }),
    paraglideVitePlugin({ project: './project.inlang' }),
    mockApiPlugin(mock),
  ],
  resolve: {
    alias: { $lib: path.resolve('./src/lib') },
  },
  server: {
    port: 5173,
    proxy: mock
      ? undefined
      : {
          '/api': {
            target: 'http://localhost:4173',
            changeOrigin: true,
          },
        },
  },
  preview: {
    port: 4174,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
