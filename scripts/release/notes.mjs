#!/usr/bin/env node
// Print the CHANGELOG.md section for a version (default: current) to stdout.
// Used as the GitHub Release body so the release page and CHANGELOG stay in sync.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const version =
  process.argv[2]?.replace(/^v/, '') ?? JSON.parse(readFileSync(join(repo, 'packages/atento/package.json'), 'utf8')).version
const lines = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8').split('\n')
const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().startsWith(version))
if (start < 0) {
  console.error(`no CHANGELOG entry for ${version}`)
  process.exit(1)
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
process.stdout.write(`${lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()}\n`)
