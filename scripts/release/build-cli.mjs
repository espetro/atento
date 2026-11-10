#!/usr/bin/env node
// Build the self-contained `atento` + `atento-mcp` release tarball for the
// current platform: a Node runtime, the pnpm-deployed @atento/cli (which
// carries @atento/mcp and @atento/server) and the built web ui, behind two
// small launcher scripts.
//
//   atento-<version>-<os>-<arch>/
//     bin/atento        CLI, `atento serve` serves the bundled ui
//     bin/atento-mcp    MCP server over stdio
//     lib/              node, deployed packages, ui-dist
//
// Usage: node scripts/release/build-cli.mjs [--out dist-release]
// Prerequisite: `pnpm build` (packages and ui).
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outArg = process.argv.indexOf('--out')
const outDir = resolve(repo, outArg > 0 ? process.argv[outArg + 1] : 'dist-release')
const version = JSON.parse(readFileSync(join(repo, 'packages/atento/package.json'), 'utf8')).version
const os = { darwin: 'darwin', linux: 'linux' }[process.platform]
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
if (!os || !arch) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)

const name = `atento-${version}-${os}-${arch}`
const root = join(outDir, name)
const lib = join(root, 'lib')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, ...opts })

if (!existsSync(join(repo, 'packages/ui/dist/index.html'))) {
  throw new Error('packages/ui/dist is missing, run `pnpm build` first')
}

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

console.log('==> deploying @atento/cli')
run('pnpm', ['--filter', '@atento/cli', 'deploy', '--prod', lib])
cpSync(join(repo, 'packages/ui/dist'), join(lib, 'ui-dist'), { recursive: true })
copyFileSync(process.execPath, join(lib, 'node'))
chmodSync(join(lib, 'node'), 0o755)

// Resolve symlinks (mise and brew link into PATH) before locating lib/.
const launcher = (entry) => `#!/bin/sh
self="$0"
while [ -L "$self" ]; do
  dir="$(cd "$(dirname "$self")" && pwd)"
  self="$(readlink "$self")"
  case "$self" in /*) ;; *) self="$dir/$self" ;; esac
done
here="$(cd "$(dirname "$self")/.." && pwd)"
ATENTO_UI_DIST="\${ATENTO_UI_DIST:-$here/lib/ui-dist}" exec "$here/lib/node" "$here/lib/${entry}" "$@"
`
mkdirSync(join(root, 'bin'))
for (const [bin, entry] of [
  ['atento', 'dist/bin.js'],
  ['atento-mcp', 'node_modules/@atento/mcp/dist/bin.js'],
]) {
  writeFileSync(join(root, 'bin', bin), launcher(entry))
  chmodSync(join(root, 'bin', bin), 0o755)
}
copyFileSync(join(repo, 'LICENSE'), join(root, 'LICENSE'))
copyFileSync(join(repo, 'README.md'), join(root, 'README.md'))

console.log('==> smoke test')
const out = execFileSync(join(root, 'bin', 'atento'), ['--version'], { encoding: 'utf8' }).trim()
console.log(`atento --version -> ${out}`)
execFileSync(join(lib, 'node'), ['-e', "new (require('better-sqlite3'))(':memory:')"], {
  cwd: join(lib, 'node_modules/@atento/db'),
  stdio: 'inherit',
})

const tarball = join(outDir, `${name}.tar.gz`)
run('tar', ['-C', outDir, '-czf', tarball, name])
console.log(`==> ${tarball}`)
