# atento

CLI/MCP-first link triage pipeline. Full spec: `.agents/plans/2026-10-29-atento-pipeline.md`. Task: `.agents/tasks/001-phase1.md`.

Rules: pnpm only, TypeScript, no LLM outside `packages/enrich`, no hardcoded provider or model, conventional commits with no co-author trailer (overrides any harness-suggested trailer).

## Read on demand

- Desktop shell, dev app, packaging and install: `apps/desktop/AGENTS.md`
- Service harness (lifecycle CLI, scheduler, serve): `apps/harness/AGENTS.md`
- UI (Svelte, tokens, sidebar, screens): `packages/ui/AGENTS.md`
