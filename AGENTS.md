# Agent notes

Smartlinks turns a JavaScript or TypeScript function body into a self-contained, executable URL.
The CLI (`src/cli`) type-checks, packages, and seals links; a Cloudflare Worker (`src/worker`)
decodes them and runs the script in a fresh QuickJS sandbox; `src/shared` is used by both sides.
The service stores nothing: no per-link records, no databases in disguise.

Most things are documented in the agent guide at
[`public/smartlinks-for-agents.md`](public/smartlinks-for-agents.md) — the authoring contract,
the `ctx` API, limits, and patterns. Read it before writing Smartlink scripts or changing runtime
behavior, and update it when the contract changes.

## Design philosophy

The pieces form a stateless actor system addressable by URL: sealed secrets are a link's private
memory, `ctx.compile` is actor creation, and the client carrying the URL is the message bus. When
unsure whether a proposed primitive belongs, ask what a stateless actor needs — delegation chains
and callbacks fall out of the model; registries and counters visibly do not.

The rules that do the actual work:

1. **Statelessness is inviolable.** No stored per-link records. Use-counters, revocation lists,
   short aliases, and per-link analytics are databases in disguise and are rejected on sight.
   Expiry is the kill switch; counting is the client's job.
2. **Host additions are algorithms, not policies.** Only four things are inherently above QuickJS:
   holding a secret, speaking as the runtime, entropy, and budget enforcement. Anything else
   becomes a documented pattern in the guide, not API surface.
3. **Authority attenuates monotonically; policy is authorial.** A child link never exceeds its
   parent, but the runtime authenticates the author's choices rather than judging them.
4. **No strings, only closures.** Code is fixed at build time; runtime supplies data. This is what
   makes minting not-`eval`.
5. **Patterns graduate on evidence.** A documented pattern that shows up in every third script can
   be promoted to sugar over the same primitive — designed from observed usage, not speculation.

When writing docs, follow the guide's style contract: readers are capable models, so explain the
mechanism once and hint per rule. Be explicit only about names, formats, limits, and negative
space — what deliberately does not exist, so it does not get invented.

## Commands

- `npm run check` — format check, typecheck, all tests, worker dry-run; run before committing
- `npm test` — unit, worker, and CLI e2e tests
- `npm run format` — Biome autofix
