#!/usr/bin/env node
// Build the native scriptc binary for the current target and stage it as a
// release artifact.
//
//   node packages/native/scripts/release.mjs [--out dist-release/native]
//
// The binary is the same source tree the Node CLI serves (`packages/native/src`),
// built with scriptc against the published @cutils/sqlite, @cutils/cli and
// @chttp/mcp packages. It is shipped next to the Node tarball as
// `atento-native-<os>-<arch>` so a user can pick the self-contained binary.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const outArg = process.argv.indexOf('--out')
const outDir = resolve(repo, outArg > 0 ? process.argv[outArg + 1] : 'dist-release/native')
const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
if (!os || !arch) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)

const pkgDir = join(repo, 'packages/native')
const name = `atento-native-${os}-${arch}`
const out = join(outDir, `${name}${process.platform === 'win32' ? '.exe' : ''}`)

mkdirSync(outDir, { recursive: true })
rmSync(out, { force: true })

console.log(`==> building ${name}`)
execFileSync('sh', ['scripts/build.sh', 'src/cli.ts', out], { cwd: pkgDir, stdio: 'inherit' })

if (!existsSync(out)) throw new Error(`the build did not produce ${out}`)

// Smoke test: the binary must at least answer --version and open a database.
execFileSync(out, ['--version'], { stdio: 'inherit' })
console.log(`==> ${out}`)
