#!/usr/bin/env node
// The scriptc toolchain payloads (ts7, tsc-ts, the llvm helpers) ship
// non-executable in the npm tarball; scriptc's postinstall chmods them once.
// A pnpm store-cache restore can bring the 644 mode back, and the compiler
// then fails with SC3004 "TypeScript server startup: Permission denied".
// Repair the modes from the installed manifest before every native build.
import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The manifest paths are relative to the scriptc package's bin directory.
// Resolve the symlink first: a pnpm link is a directory symlink, so a textual
// ".." would escape into the wrong tree.
const bin = realpathSync(resolve(import.meta.dirname, '..', 'node_modules', 'scriptc', 'bin'))
const manifestPath = join(bin, 'scriptc.exe.json')
if (!existsSync(manifestPath)) {
  console.error('fix-toolchain-modes: scriptc is not installed (no bin/scriptc.exe.json)')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const paths = [manifest.ts7, ...(manifest.tsc_ts ? [manifest.tsc_ts] : [])]
if (manifest.llvm_package) {
  paths.push(join(manifest.llvm_package, 'bin/scriptc-llvm-codegen'))
  paths.push(join(manifest.llvm_package, 'bin/scriptc-comptime'))
}

let fixed = 0
for (const relative of paths) {
  if (!relative) continue
  const path = resolve(bin, relative)
  if (!existsSync(path)) {
    console.error(`fix-toolchain-modes: missing ${path}`)
    process.exit(1)
  }
  try {
    // Probe executability instead of trusting the mode bits: a hard-linked
    // store file may already report 755 while a restored cache entry is 644.
    process.accessSync(path, process.constants.X_OK)
  } catch {
    chmodSync(path, 0o755)
    fixed++
  }
}
if (fixed > 0) console.log(`fix-toolchain-modes: made ${fixed} scriptc toolchain binaries executable`)
