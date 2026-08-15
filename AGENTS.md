# Agent notes

Smartlinks turns a JavaScript or TypeScript function body into a self-contained, executable URL.
The CLI (`src/cli`) type-checks, packages, and seals links; a Cloudflare Worker (`src/worker`)
decodes them and runs the script in a fresh QuickJS sandbox; `src/shared` is used by both sides.
The service stores nothing: no per-link records, no databases in disguise.

Most things are documented in the agent guide at
[`public/smartlinks-for-agents.md`](public/smartlinks-for-agents.md) — the authoring contract,
the `ctx` API, limits, and patterns. Read it before writing Smartlink scripts or changing runtime
behavior, and update it when the contract changes.

## Commands

- `npm run check` — format check, typecheck, all tests, worker dry-run; run before committing
- `npm test` — unit, worker, and CLI e2e tests
- `npm run format` — Biome autofix
