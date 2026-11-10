# apps/desktop

Electrobun shell around the atento UI. Details: `README.md`. Packaging: `scripts/package.sh`.

## Dev app must be running (mandatory)

Keep the dev desktop app running whenever you change `packages/ui` or `apps/desktop`, so the user can test changes in the real shell (ACP agent dock and native website preview only exist there, never on plain web).

1. API: `node ~/Applications/atento.app/Contents/Resources/server/server-entry.mjs` or `node apps/harness/dist/bin.js start` (port 4173).
2. UI dev server: `pnpm --filter @atento/ui dev --host 127.0.0.1 --port 5199`.
3. Shell: `cd apps/desktop && PATH="$HOME/.hutch/bin:$PATH" ATENTO_URL=http://127.0.0.1:5199 hutch run dev`.

Check before reporting back that all three are alive and the shell log has no errors. Say so if you could not verify it visually (a native window cannot be screenshotted; use the web preview on the vite URL for visual checks).

## Updating the installed app

`~/Applications/atento.app` is a packaged build and goes stale. Rebuild with `flock /tmp/tsc.lock sh -c 'pnpm --filter @atento/ui build && bash apps/desktop/scripts/package.sh'`. It replaces the installed app and ad-hoc signs it. The installed app and the dev sidecar both want port 4173.

## Rules

- Not part of `pnpm -r build/test/typecheck`; deps are managed by `hutch`, not pnpm.
- The sidecar runs under Node, not Bun (better-sqlite3).
- `.hutch/`, `build/`, `node_modules/` are gitignored.
