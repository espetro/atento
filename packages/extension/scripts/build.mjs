// Build script: esbuild bundles the service worker and the options script,
// and the static files are copied next to them. The output is the unpacked
// extension directory: load packages/extension/dist in the browser.
//
// esbuild, not vite: the extension has no framework and no dev server, and
// one command produces exactly the layout the manifest expects.
import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const out = join(root, 'dist')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

await build({
  entryPoints: {
    background: join(src, 'background.ts'),
    content: join(src, 'content.ts'),
    options: join(src, 'options.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
})

for (const file of ['manifest.json', 'options.html']) {
  await cp(join(src, file), join(out, file))
}

console.log(`extension built into ${out}`)
