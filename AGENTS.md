# Agent notes

Smartlinks turns a JavaScript or TypeScript function body into a self-contained, executable URL.
The CLI (`src/cli`) type-checks, packages, and seals links; a Cloudflare Worker (`src/worker`)
decodes them and runs the script in a fresh QuickJS sandbox; `src/shared` is used by both sides.
The service stores nothing: no per-link records, no databases in disguise.

Most things are documented in the agent guide at
[`public/smartlinks-for-agents.md`](public/smartlinks-for-agents.md) — the authoring contract,
the `ctx` API, limits, and patterns. Read it before writing Smartlink scripts or changing runtime
behavior, and update it when the contract changes.

## How it is built

TypeScript throughout. The CLI ships as an npm package bundled with tsup; the runtime is a
Cloudflare Worker deployed with Wrangler; the website in `public/` is static files on Vercel.

Building a link: the CLI type-checks the script against the runtime contract with the bundled
TypeScript compiler, parses with acorn (`eslint-scope` resolves closure captures for
`ctx.compile`, astring re-emits), optionally minifies with terser, validates the exact stored
wrapper in QuickJS, seals secrets with HPKE (X25519 / HKDF-SHA256 / AES-128-GCM via `@hpke/core`)
bound to the whole artifact, deflates with fflate, and base64url-encodes the result into the URL.

Executing one: the Worker reverses the codec, decrypts secrets with its private key, and runs the
script in a fresh QuickJS sandbox (`quickjs-emscripten-core` on a WASM build) with budgeted,
SSRF-guarded fetch. The return value maps to the HTTP response. Everything security-relevant —
codec, sealing, sandbox setup, guarded fetch — lives in `src/shared` so `smartlinks run`
executes exactly what production executes.

Tests: Vitest for unit and Worker suites (the latter on `@cloudflare/vitest-pool-workers`, real
workerd), `node --test` for CLI end-to-end. Biome formats and lints.

## Where it runs

- <https://s.jonaslsa.com> — the runtime (Cloudflare Worker custom domain); links execute here,
  and it is the CLI's default service URL
- <https://smartlinks.jonaslsa.com> — product page, serving `public/` from Vercel, including the
  hosted copy of the agent guide at `/smartlinks-for-agents.md`

## External references

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — CPU and memory
  ceilings the execution budgets are designed around
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) —
  for `wrangler.jsonc`, including the rate-limiting binding
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) —
  how the Worker test suite runs inside workerd
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) — the sandbox engine
- [RFC 9180 (HPKE)](https://www.rfc-editor.org/rfc/rfc9180) — the sealing construction

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

This places the project in the object-capability tradition (Hewitt's actors → the E language →
ocap systems), and that literature is the right prior art when reasoning about additions: a link
is an unforgeable capability URL, rule 3 is capability discipline, `compile` is attenuating
delegation, the fetch-gated kill-switch pattern is Redell's caretaker, the parked `sealFor` is
E's sealer/unsealer pairs, and the author-identity problem is Zooko's triangle — its badge design
follows petname-system discipline. Where the actor analogy strains — no mailboxes, no supervision,
every message carried by a client moving a URL — is the point: anything that needs the *service*
to hold a message is smuggling in a mailbox.

When writing docs, follow the guide's style contract: readers are capable models, so explain the
mechanism once and hint per rule. Be explicit only about names, formats, limits, and negative
space — what deliberately does not exist, so it does not get invented.

## Commands

- `npm run check` — format check, typecheck, all tests, worker dry-run; run before committing
- `npm test` — unit, worker, and CLI e2e tests
- `npm run format` — Biome autofix
