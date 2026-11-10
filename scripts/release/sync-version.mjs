#!/usr/bin/env node
// After `changeset version`: copy the umbrella package's version to the root
// package, the desktop app config, and mirror its CHANGELOG to the repo root.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
const version = JSON.parse(read('packages/atento/package.json')).version

for (const file of ['package.json', 'apps/desktop/package.json']) {
  const json = JSON.parse(read(file))
  json.version = version
  writeFileSync(join(repo, file), `${JSON.stringify(json, null, file.startsWith('apps') ? '\t' : 2)}\n`)
}
const cfg = 'apps/desktop/electrobun.config.ts'
writeFileSync(join(repo, cfg), read(cfg).replace(/version: "[^"]*"/, `version: "${version}"`))
try {
  copyFileSync(join(repo, 'packages/atento/CHANGELOG.md'), join(repo, 'CHANGELOG.md'))
} catch {
  // first release before any changeset: the hand-written root CHANGELOG stays.
}
console.log(`synced version ${version}`)
