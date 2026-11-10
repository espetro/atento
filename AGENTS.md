# atento

CLI/MCP-first link triage pipeline. Full spec: `.agents/plans/2026-10-29-atento-pipeline.md`. Task: `.agents/tasks/001-phase1.md`.

Rules: pnpm only, TypeScript, no LLM outside `packages/enrich`, no hardcoded provider or model, conventional commits with no co-author trailer (overrides any harness-suggested trailer).

## Read on demand

- Desktop shell, dev app, packaging and install: `apps/desktop/AGENTS.md`
- Service harness (lifecycle CLI, scheduler, serve): `apps/harness/AGENTS.md`
- UI (Svelte, tokens, sidebar, screens): `packages/ui/AGENTS.md`

## Builds and releases

- All release builds (CLI tarballs, desktop apps) happen in GitHub Actions. Never build or package release artifacts locally, and never upload local artifacts to a release. Local runs are limited to typecheck, tests and the dev app.
- Reference for Electrobun packaging, signing and Windows: `../calca` (`.github/workflows/desktop.yml`, `release-cli.yml`). Windows desktop and CLI are planned for 0.1.1 or 0.2.0.
- The MCP server ships with the CLI (`atento mcp`), separate from the desktop app asset (`Atento-desktop-*`).
