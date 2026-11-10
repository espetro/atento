#!/usr/bin/env node
// Run by the changesets action once a "Version Packages" PR merges: tag the
// release and dispatch the build workflow (tags pushed with GITHUB_TOKEN do
// not trigger workflows on their own).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = JSON.parse(readFileSync(join(repo, 'packages/atento/package.json'), 'utf8')).version
const tag = `v${version}`
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo })
const exists = execFileSync('git', ['ls-remote', '--tags', 'origin', tag], { encoding: 'utf8' }).trim() !== ''
if (exists) {
  console.log(`${tag} already exists`)
} else {
  sh('git', ['tag', tag])
  sh('git', ['push', 'origin', tag])
  sh('gh', ['workflow', 'run', 'release.yml', '-f', `tag=${tag}`])
}
