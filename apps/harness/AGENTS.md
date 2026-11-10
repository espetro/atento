# apps/harness

`@linkinbox/harness`: lifecycle CLI (`linkinbox-harness`), recurrence scheduler, native notifications and static web serving. Source in `src/` (`lifecycle`, `scheduler`, `serve`, `static`, `install`, `notify`, `runs`, `config`), tests in `test/`.

## Commands

- Build: `pnpm --filter @linkinbox/harness build` (tsc to `dist/`).
- Test: `flock /tmp/tsc.lock pnpm --filter @linkinbox/harness test`.
- Typecheck: `flock /tmp/tsc.lock pnpm --filter @linkinbox/harness typecheck`.
- Serve UI + API: `node apps/harness/dist/bin.js start` (binds :4173; serves `packages/ui/dist`).

## Rules

- No LLM calls here; enrichment lives in `packages/enrich`.
- The desktop shell loads this server, so rebuild `dist/` before testing the desktop app against it.
- Never write to the user's real DB (`~/.linkinbox/links.db`) from tests; use temp dirs.
