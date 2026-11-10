# apps/harness

`@atento/harness`: lifecycle CLI (`atento-harness`), recurrence scheduler, native notifications and static web serving. Source in `src/` (`lifecycle`, `scheduler`, `serve`, `static`, `install`, `notify`, `runs`, `config`), tests in `test/`.

## Commands

- Build: `pnpm --filter @atento/harness build` (tsc to `dist/`).
- Test: `flock /tmp/tsc.lock pnpm --filter @atento/harness test`.
- Typecheck: `flock /tmp/tsc.lock pnpm --filter @atento/harness typecheck`.
- Serve UI + API: `node apps/harness/dist/bin.js start` (binds :4173; serves `packages/ui/dist`).

## Rules

- No LLM calls here; enrichment lives in `packages/enrich`.
- The desktop shell loads this server, so rebuild `dist/` before testing the desktop app against it.
- Never write to the user's real DB (`~/.atento/links.db`) from tests; use temp dirs.
