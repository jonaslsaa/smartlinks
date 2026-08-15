# Handoff: smartlinks — "the link is the script"

## What this is

A stateless serverless tool where a URL *contains* a small JavaScript program.
Visiting the link decodes, sandboxes, and runs the script on a Cloudflare
Worker; query parameters are the per-run variables; the script's return value
becomes the HTTP response (often a redirect). Nothing is stored anywhere — no
database, no accounts. The link is the deployment.

Motivating example: a link in a GitHub PR comment that, when clicked,
transforms its query params, calls `workflow_dispatch` on the GitHub API with
a sealed (encrypted) token, and redirects the clicker to the Actions run page.

Other target use cases: webhook shape-adapters (Stripe → Slack etc.), smart
redirects (latest-release-for-your-OS, time-based meeting links), README
badges (script returns SVG), iCal/RSS feed filters, shareable mock API
endpoints.

This is a hobby tool for the author and friends. Keep everything small and
simple. Be upfront about the downsides on the homepage (immutable links can't
be fixed, anyone with a link can run it, etc.).

## Decisions already made (do not relitigate)

1. **Platform**: Cloudflare Worker for link execution, free tier. One worker,
   no storage bindings. The public landing page is a static site hosted on
   Vercel.
2. **No `eval`**: Workers forbid it, and we don't want user code in our isolate
   anyway. Execute scripts in a **QuickJS-in-WASM interpreter** (use
   `quickjs-emscripten`, or `@sebastianwessel/quickjs` if it keeps things
   simpler). Fresh interpreter runtime per request, torn down after.
3. **No database.** The URL is the only artifact. (A denylist KV may be added
   later; not in v1.)
4. **Runtime contract**: the script gets the incoming request context and may
   do side effects. Its return value maps to the response:
   - string → treated as a URL, respond 302 to it
   - object `{ status?, headers?, body? }` → literal response
   - `undefined` → default "✓ done" page
5. **Sealed secrets**: secrets are encrypted by the CLI with **HPKE
   (RFC 9180, X25519 + ChaCha20-Poly1305 or AES-GCM — use `@hpke/core`)** to
   the service's public key. Modern v2 links mark complete-artifact binding with
   `a: 1`; their AAD covers the key ID plus a canonical hash of the payload
   version, entry script, ordered compile table, baked program data, exact
   `notAfter`/no-expiry state, execution-policy flags, and target secret name. A
   sealed blob therefore decrypts only for the immutable program and authority
   the author built. The Worker retains the earlier script-and-expiry AAD reader
   only so links produced during the deployment transition continue to run.
   Private key lives in a worker secret (`wrangler secret`). A **key ID**
   prefixes every sealed blob so the keypair can be rotated additively.
6. **Versioned encoding**: the payload starts with a version character; current
   links use `2`. While the product has no users, v2 may evolve in place rather
   than carrying migration code. Once links are in external use, incompatible
   format changes require a new version.
7. **Bot/prefetch handling**: link previews and prefetchers must never execute
   scripts (pasting an action link into Slack must not fire it). Detection is
   **blocklist-based** (never an allowlist — curl and webhook senders send no
   `Sec-Fetch` headers and must still work):
   - `HEAD` requests → always a no-op preview response
   - User-Agent matching known unfurlers (`Slackbot-LinkExpanding`,
     `Discordbot`, `Twitterbot`, `facebookexternalhit`, `github-camo`,
     `WhatsApp`, `LinkedInBot`, `TelegramBot`, `Googlebot`, `bingbot`) →
     preview page, no execution
   - `Sec-Purpose`/`Purpose: prefetch` headers → preview page, no execution
8. **Interstitial is per-link opt-in** (author's choice, flag in the
   envelope). When enabled: GET renders a confirmation page showing the
   pretty-printed decoded script with a form that **POSTs** back with
   `__confirm=1` to actually execute. When disabled: GET executes directly
   (minus bots, per #7).
9. **Guarded fetch** inside the sandbox: http(s) only, block private/loopback
   /link-local IPs and localhost, cap ~5 subrequests and ~1 MB per response.
10. **Size budget**: total URL must stay comfortably under 8,000 chars;
    compress aggressively.
11. **Optional expiry**: `notAfter` is integer Unix seconds in UTC. Normal
    execution requests after the deadline return HTTP 410 before interstitial,
    rate limiting, secret decryption, body reading, or sandbox execution.
    Preview, prefetch, and `HEAD` handling stays non-executing and returns the
    preview. Expiry is cryptographically bound when secrets are sealed and
    advisory for secret-free links, whose public source can be rebuilt.
12. **Runtime minting**: `ctx.compile(closure, args, options?)` may mint one
    child link per execution. The CLI statically extracts inline or top-level
    constant closures, rejects outer captures, and replaces function references
    with compact table indexes. Args are a typed positional JSON tuple. Children
    are ordinary links and may carry their own approved compile closures; there
    is no stored tree, generation field, or depth rule.

## URL and envelope format

```
https://<domain>/r/<payload>?<user params...>
```

- `<payload>` = `"2"` + base64url( deflate-raw( UTF-8 JSON envelope ) ).
  Use `CompressionStream('deflate-raw')` — available in both Node ≥18
  (CLI) and Workers (runner).
- Envelope JSON (short keys, they're paid for by every link):

```json
{
  "s": "<script source>",
  "i": true,
  "a": 1,
  "c": ["<compile closure>"],
  "k": { "TOKEN": "<base64url sealed blob>" },
  "n": 2000000000
}
```

  `s` = script, `i` = interstitial flag (optional), `a` = complete-artifact AAD
  marker (optional), `c` = ordered compile closure table (optional), `k` =
  sealed secrets by name (optional), `n` = `notAfter` expiry as integer Unix
  seconds (optional). Decoders still accept the earlier verbose `notAfter` wire
  key, but authors emit only `n`.
- Query params starting with `__` are reserved for the service
  (`__confirm`); all others belong to the script.
- Sealed blob layout: `keyId (1 byte) || hpke enc || ciphertext`.

## Script API (inside the QuickJS sandbox)

The script source is wrapped as `(async (ctx) => { <source> })(ctx)` — i.e.
authors write a plain async function body and `return` their result. `ctx`:

```
ctx.params    // object: query params (minus __reserved)
ctx.paramValues // object: every value for repeated query params
ctx.method    // "GET" | "POST" | ...
ctx.headers   // object, lowercased keys
ctx.body      // string | null (request body, if any)
ctx.secrets   // object: decrypted secrets by name (plaintext strings)
ctx.requestId // opaque execution correlation ID
ctx.crypto    // SHA-256 and HMAC-SHA256 helpers
ctx.compile   // one runtime child mint from a packaged closure + positional tuple

fetch(url, opts) // guarded global fetch bridge (see decision #9); returns a
                 // bounded Response-like object with text() and json()
```

Host↔guest boundary passes plain JSON-able values only.

## Routes (single worker)

| Route | Behavior |
|---|---|
| `GET /` | Temporary redirect to the public landing page |
| `ALL /r/<payload>` | Runner: preview check → decode → expiry check → interstitial → rate limit → decrypt secrets (verify complete-artifact AAD for modern links) → read body → sandbox, including one optional mint → map return value to response |
| `GET /d/<payload>` | Decoder: pretty-printed entry script, compile closures, and envelope metadata; "audit before you click" page |
| `GET /pk` | Current public key + key ID (JSON) — the CLI uses this to seal |

## Landing page

A super simple static HTML page hosted on Vercel from this repository — no
framework or build step. Content: one-paragraph explanation, a copy-pasteable
CLI install + usage example, an example link to try, and the honest downsides
list (immutable links, anyone-with-link-can-run, best-effort hobby service).
That's all. Authoring happens entirely in the CLI.

## CLI tool

All authoring happens here. TypeScript, runs on Node ≥18, lives in the same
repo and **imports the same codec/seal/sandbox modules the worker uses** so
link formats can never drift. Commands:

```
smartlinks build <script.js|script.ts> [--interstitial] [--secret NAME[=value]] [--expires 7d]
    # strictly type-check .ts input, transpile, compress + encode; fetch /pk
    # and HPKE-seal secrets bound to the script and expiry. --copy or --out
    # keeps the finished link out of terminal output while reporting its size.
    # --secret NAME without a value reads $NAME from the environment, or
    # prompts on a TTY — so secrets stay out of shell history.

smartlinks decode <link | payload>
    # print the pretty-printed script + envelope metadata

smartlinks run <script.js|script.ts> [--param a=1 ...] [--method POST] [--body ...]
    # type-check .ts input and execute locally in the same QuickJS sandbox as
    # production, with fake ctx; secrets provided via env. Prints the mapped
    # response. ctx.compile uses ephemeral local encryption; run follows and
    # executes local-only compiled links rather than publishing them.
```

Both TypeScript commands accept `--no-type-check` to transpile without semantic checking.

The public CLI uses the baked-in service domain. Runtime operators and
self-hosters can override it with `SMARTLINKS_URL`.

## Deliverables checklist

1. Wrangler + TypeScript project scaffold (`wrangler.jsonc`, this repo dir).
2. `src/codec.ts` — envelope encode/decode with version byte. Unit-tested.
3. `src/seal.ts` — HPKE seal/open with keyId + script-and-expiry AAD. Unit
   tests prove a blob fails to open for a different script or altered expiry.
4. `src/sandbox.ts` — QuickJS execution, ctx bridge, guarded fetch, return
   value mapping. Test: script can't reach host globals; private-IP fetch is
   rejected.
5. `src/bots.ts` — preview/prefetch detection per decision #7.
6. `src/worker/index.ts` — runner routes and interstitial flow.
7. `src/cli/` — the CLI (`build` / `decode` / `run`), sharing `src/shared/`
   codec, seal, and sandbox modules with the worker. Round-trip test: link
   built by the CLI executes correctly in the worker.
8. Runtime minting — static closure extraction, complete-artifact AAD, shared
   local/Worker mint pipeline, one-attempt CPU guard, and parent→child→leaf tests.
9. Internal keygen command that prints a keypair or provisions
   `PRIVATE_KEY_<id>` through Wrangler; self-hosting instructions stay in the README.
10. README: what it is, the honest downsides list, CLI usage, example links
   (redirect, badge, webhook adapter, GitHub workflow_dispatch).
11. Tests runnable via `vitest` with `@cloudflare/vitest-pool-workers`;
    `wrangler dev` works locally.

## Explicit non-goals for v1

Accounts, storage, analytics, rate limiting, denylist, custom domains per
user, non-JS languages, editing existing links (immutability is the model).

## Open items (defaults chosen — proceed unless told otherwise)

- **Name/domain**: `smartlinks`. The public service runs at `https://s.jonaslsa.com`
  as a Cloudflare Worker Custom Domain, kept as a single CLI default.
- **CLI distribution**: published on npm as `@jonaslsa/smartlinks`.
- **Workers CPU allowance**: external latency and local startup samples are not CPU-time
  measurements, and the deterministic QuickJS interrupt count is not calibrated to CPU cycles.
  Validate the deployed runtime with Cloudflare's CPU metrics. If the chosen plan is too tight
  in practice, upgrading is the accepted fix, not re-architecting.
- Builder "test run" button: nice-to-have; skipping it in v1 is fine (build
  the link, click it).
