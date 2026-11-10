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
const isWin = process.platform === 'win32'
const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
if (!os || !arch) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)

const name = `atento-${version}-${os}-${arch}`
const root = join(outDir, name)
const lib = join(root, 'lib')
// pnpm is a .cmd shim on Windows, which Node only spawns through a shell.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repo, shell: isWin && cmd === 'pnpm', ...opts })

if (!existsSync(join(repo, 'packages/ui/dist/index.html'))) {
  throw new Error('packages/ui/dist is missing, run `pnpm build` first')
}

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

console.log('==> deploying @atento/cli')
// Windows: hoisted layout (real directories instead of junctions).
run('pnpm', ['--filter', '@atento/cli', 'deploy', '--prod', ...(isWin ? ['--config.node-linker=hoisted'] : []), lib])
cpSync(join(repo, 'packages/ui/dist'), join(lib, 'ui-dist'), { recursive: true })
const nodeName = isWin ? 'node.exe' : 'node'
copyFileSync(process.execPath, join(lib, nodeName))
chmodSync(join(lib, nodeName), 0o755)

// Resolve symlinks (mise and brew link into PATH) before locating lib/.
const launcher = (entry, args = '') => `#!/bin/sh
self="$0"
while [ -L "$self" ]; do
  dir="$(cd "$(dirname "$self")" && pwd)"
  self="$(readlink "$self")"
  case "$self" in /*) ;; *) self="$dir/$self" ;; esac
done
here="$(cd "$(dirname "$self")/.." && pwd)"
ATENTO_UI_DIST="\${ATENTO_UI_DIST:-$here/lib/ui-dist}" exec "$here/lib/node" "$here/lib/${entry}" ${args}"$@"
`
const cmdLauncher = (args) => `@echo off\r
set "HERE=%~dp0.."\r
if "%ATENTO_UI_DIST%"=="" set "ATENTO_UI_DIST=%HERE%\\lib\\ui-dist"\r
"%HERE%\\lib\\node.exe" "%HERE%\\lib\\dist\\bin.js" ${args}%*\r
`
mkdirSync(join(root, 'bin'))
// `atento-mcp` is a shortcut for `atento mcp`; the MCP server ships in every tarball.
for (const [bin, args] of [
  ['atento', ''],
  ['atento-mcp', 'mcp '],
]) {
  if (isWin) {
    writeFileSync(join(root, 'bin', `${bin}.cmd`), cmdLauncher(args))
  } else {
    writeFileSync(join(root, 'bin', bin), launcher('dist/bin.js', args))
    chmodSync(join(root, 'bin', bin), 0o755)
  }
}
copyFileSync(join(repo, 'LICENSE'), join(root, 'LICENSE'))
copyFileSync(join(repo, 'README.md'), join(root, 'README.md'))

console.log('==> smoke test')
const launcherPath = join(root, 'bin', isWin ? 'atento.cmd' : 'atento')
const out = execFileSync(launcherPath, ['--version'], { encoding: 'utf8', shell: isWin }).trim()
console.log(`atento --version -> ${out}`)
execFileSync(join(lib, nodeName), ['-e', "new (require('better-sqlite3'))(':memory:')"], {
  cwd: join(lib, 'node_modules/@atento/db'),
  stdio: 'inherit',
})

// Relative paths and cwd: GNU tar reads "C:\\..." as a remote host. bsdtar
// (Windows 10+) writes zip with -a.
const archive = isWin ? `${name}.zip` : `${name}.tar.gz`
execFileSync('tar', isWin ? ['-a', '-c', '-f', archive, name] : ['-czf', archive, name], { cwd: outDir, stdio: 'inherit' })
console.log(`==> ${join(outDir, archive)}`)
