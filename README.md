<p align="center">
  <img src="public/favicon.svg" alt="Smartlinks" width="72" height="72">
</p>

<h1 align="center">Smartlinks</h1>

<p align="center">
  <strong>Small programs. One URL. Nothing to deploy.</strong>
</p>

<p align="center">
  Turn a JavaScript or TypeScript function into a self-contained, executable link.
</p>

<p align="center">
  <a href="https://smartlinks.jonaslsa.com">Website</a> ·
  <a href="https://www.npmjs.com/package/@jonaslsa/smartlinks">npm</a> ·
  <a href="https://smartlinks.jonaslsa.com/smartlinks-for-agents.md">Build with an agent</a>
</p>

---

Smartlinks is for the useful little bits of server-side logic that do not deserve a project,
a database, or a deployment pipeline.

The program lives in the URL itself; a Cloudflare Worker decodes it, runs it in a fresh QuickJS
sandbox, and turns the result into an HTTP response. There is no repo to create, no server to keep
running, no account for whoever clicks, and nothing to tear down when you are done. Smartlinks
stores nothing — the only copy of your program is the URL itself.

| You want | Without Smartlinks | With Smartlinks |
| --- | --- | --- |
| A URL that always points at your latest release | A repo, a worker, a deploy pipeline | Eight lines and one build command |
| A teammate to trigger one deploy with your token | Hand over the token, or build an authenticated service | A link carrying the sealed token, dead by Tuesday |
| An adapter between two webhook formats | A server someone has to keep running | A URL that costs nothing while nothing calls it |

## What can a link do?

| Outcome | Example |
| --- | --- |
| Give someone a link that dispatches one GitHub workflow with your token — and expires | [GitHub workflow dispatch](examples/github-workflow-dispatch.js) |
| Point docs and chat messages at the latest version, forever | [Smart redirect](examples/redirect.js) |
| Serve an SVG badge straight from query parameters | [SVG status badge](examples/badge.js) |
| Sit between two services that speak different webhook dialects | [Webhook adapter](examples/webhook-adapter.js) |
| Share a riddle whose answer travels inside the link, checkable but unreadable | [Riddle with a sealed answer](examples/riddle.js) |
| Write the function body in TypeScript, strictly checked | [Typed response](examples/typed-response.ts) |

## Make your first Smartlink

Install the CLI (Node.js 24 or newer):

```sh
npm install --global @jonaslsa/smartlinks
```

Create `latest.ts` — a link that always redirects to the newest release of a project:

```ts
const release = await fetch("https://api.github.com/repos/cloudflare/workers-sdk/releases/latest", {
  headers: { accept: "application/vnd.github+json", "user-agent": "smartlinks" },
});
if (!release.ok) {
  return { status: 502, body: `GitHub returned HTTP ${release.status}` };
}
const { tag_name: tag } = await release.json<{ tag_name: string }>();
return `https://github.com/cloudflare/workers-sdk/releases/tag/${encodeURIComponent(tag)}`;
```

Try it locally, then build the link:

```sh
smartlinks run latest.ts --allow-network
smartlinks build latest.ts --copy
```

The copied URL is the deployment. Paste it into a doc, a chat topic, a bookmark — it follows the
latest release from now on, and nothing is running anywhere in between clicks. Pass any Smartlink
to `smartlinks decode` to audit the exact program without executing it.

## Sealed secrets: lend a credential, not the keys

Secrets are encrypted locally with the runtime's public key before they enter the URL. Only
ciphertext travels; the private key stays in the Cloudflare Worker.

```sh
export GITHUB_TOKEN=github_pat_…
smartlinks build examples/github-workflow-dispatch.js --secret GITHUB_TOKEN --expires 7d --copy
```

That link triggers a real deployment with your token, and the token never appears in the visible
or decoded link. Anyone holding the complete URL can run the program — that is the point: you are
handing over the *action*, not the credential. Scope it tight and let it expire.

The ciphertext is bound to the complete immutable program: entry function, compile closures, baked
child data, expiry, execution policy, and optional author note, plus the secret name. Change any
of those and the secrets become undecryptable — nobody can lift your sealed token into a modified
script. The expiry is part of that binding, so on links with sealed secrets it is cryptographically
enforced. Use narrowly scoped, revocable secrets; the boundary section below spells out what
sealing does and does not hide.

## Give away less than you have

A Smartlink can mint another Smartlink. `ctx.compile` turns a private parent link into a
delegation tool: it hands out smaller, purpose-built child links that carry only the authority you
chose — narrower scope, shorter life, sealed credentials the child's holder never sees.

```ts
const deploy = async (ctx: SmartlinksContext, repo: string) => {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${ctx.secrets.GITHUB_TOKEN}`,
        "user-agent": "smartlinks",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  return { status: response.ok ? 200 : 502, body: response.ok ? "Deploy started." : "GitHub refused." };
};

const child = await ctx.compile(deploy, ["your-org/your-app"], {
  ttlSeconds: 3600,
  seal: { GITHUB_TOKEN: ctx.secrets.GITHUB_TOKEN! },
});
return { status: 201, body: child };
```

Return the child in the body, not as a bare URL — a bare URL becomes a 302 redirect, which would
execute the child on the spot instead of handing it out. You keep the parent private; each
execution produces a fresh child link that can trigger deploys of a single repository's workflow,
as often as its holder likes, for one hour. No revocation list to maintain, no service to run —
the narrow capability is the URL you hand out.

The CLI extracts and approves child closures at build time; runtime values enter only through a
typed positional tuple. The first closure parameter is the child execution context, supplied by
the runtime. Closures must be inline or top-level `const`/function declarations. They may call
transitively packaged top-level helpers and read immutable primitive constants; helpers may use
parameters, locals, supported globals, and other eligible declarations, but never the parent's
`ctx`. Other parent values enter through the tuple. Packaged helpers are definitions, not mutable
runtime function objects, so every use outside a direct `ctx.compile` closure position must be a
direct call.
`ttlSeconds` can never extend a parent expiry. `interstitial` may be set explicitly or inherited;
`note` adds a child-specific author note and implies an interstitial. `seal` accepts strings the
parent deliberately chose: delegated, derived, or generated. A child carrying its own statically
approved closures can mint again.

Two rules keep this safe. A parent whose mint branch is reachable by anyone holding its URL is an
unauthenticated admin endpoint — keep parents private or verify a signed request before compiling.
And tuple values are data: never interpret attacker-controlled values as code inside a child
carrying sealed authority. The runtime's exact-byte scan blocks accidental plaintext copies of
parent secrets into child source or tuple data, but it cannot recognize transformed values and is
not an information-flow boundary.

## Remember across requests

Smartlinks stores nothing, but a link can still remember: it seals a small value into an encrypted
token, the visitor carries the token in a URL, and the link opens it on the next request. The
visitor can neither read nor forge what they carry.

```ts
const state = ctx.params.s ? await ctx.crypto.open(ctx.params.s) : { step: 1, answers: [] };
const next = await ctx.crypto.seal({ ...state, step: state.step + 1 });
```

That one trick covers a lot: a multi-step form whose session lives in a query parameter, a quiz
link whose answer is embedded but unreadable, a cooldown timer the client carries itself, a
voucher issued by one link and redeemed by another.

Only the exact link that sealed a token can open it — edit and rebuild the script, and old tokens
die with the old link. For tokens that must survive rebuilds or travel between two cooperating
links, generate a key once (`export VOUCHER_KEY=$(openssl rand -base64 32)`), seal it into each
build with `--secret VOUCHER_KEY`, and pass `{ key: ctx.secrets.VOUCHER_KEY }`. Copyable versions
of all four patterns are in the [agent guide](public/smartlinks-for-agents.md).

## The script contract

Smartlink scripts receive one small `ctx` object:

| Value | What it contains |
| --- | --- |
| `ctx.params` | Query parameters |
| `ctx.paramValues` | Every value for repeated query parameters |
| `ctx.method` | Incoming HTTP method |
| `ctx.headers` | Incoming headers with lowercase names, excluding `cookie` |
| `ctx.body` | Request body as a string, or `null` |
| `ctx.secrets` | Decrypted plaintext values, keyed by secret name |
| `ctx.requestId` | Opaque ID for correlating one execution |
| `ctx.crypto` | Host entropy, hashing, HMAC, and sealed-token helpers backed by Web Crypto |
| `ctx.compile` | Mint one immutable child Smartlink from build-time-approved code |

Scripts also get a global, guarded `fetch(url, options)` with familiar string URL, method, header,
and string-body options, returning a Response-like value with `status`, `ok`, `url`, `redirected`,
`headers`, `text()`, and `json()`. Browser-compatible `btoa` and `atob` handle Latin-1 binary
strings. Top-level `await` works.

`ctx.crypto` provides `random`, `sha256`, `hmacSha256`, and `verifyHmacSha256` (lowercase hex by
default, Base64 on request), plus `seal` and `open` for encrypted state tokens. `random` draws up
to 256 bytes of host entropy; an execution has 16 cryptographic operations in total. Prefer HMAC
with a sealed key, `ctx.requestId`, and a counter when deriving values from existing authority;
use `random` when a link must originate a fresh key or nonce. `Math.random` is not
cryptographically secure.

Return an absolute URL for a `302` redirect, `{ status?, headers?, body? }` for a text response,
`{ status?, headers?, bodyBase64 }` for bytes (1 MiB after decoding), or nothing for a small
success page. `body` and `bodyBase64` are mutually exclusive. Every response receives the
runtime's fixed Content Security Policy, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`; an author CSP can tighten but not
replace that floor. Other headers remain author-controlled except `Set-Cookie` and
`Clear-Site-Data` — browser cookie state is deliberately unsupported — and the runtime reserves
`X-Smartlinks-Preview` so executed responses cannot impersonate previews.

TypeScript input is strictly type-checked against the Smartlinks `ctx`, global `fetch`, and
response contract, then transpiled. `--no-type-check` skips semantic checking and only strips
types.

## Verified authors

`smartlinks login` verifies a GitHub account through a zero-permission GitHub App device flow,
creates a dedicated Ed25519 key locally, and receives a compact Smartlinks author certificate.
The GitHub access token is consumed during issuance and never stored; the private key never
leaves the machine.

```sh
smartlinks login
smartlinks build latest.ts --sign --copy
```

`build --sign` signs every immutable, authority-bearing payload field. The Worker verifies the
certificate and signature before execution; `decode` performs the same verification offline.
Signing proves provenance, not safety, and grants no extra capabilities. Certificates expire
after 90 days — `smartlinks whoami` checks readiness (with `--json` for CI), and `smartlinks
login` renews. Unsigned links remain fully supported; compiled children are separate, unsigned
artifacts.

## The CLI

```text
smartlinks build <script.js|script.ts>   Build an immutable execution URL
smartlinks run <script.js|script.ts>     Run locally with the production sandbox
smartlinks decode <link-or-payload>      Inspect a Smartlink without executing it
smartlinks login                         Verify GitHub and create an author signing key
smartlinks whoami                        Check the configured author and certificate expiry
smartlinks logout                        Remove the local author signing identity
```

Use `smartlinks --help` or `smartlinks help <command>` for every option. Useful build flags
include `--secret`, `--expires`, `--interstitial`, `--interstitial-note`, `--sign`, `--copy`,
`--out`, `--json`, `--no-minify`, and `--no-type-check`. `--expires` accepts a duration such as
`30m`, `1h`, or `7d`, or an absolute ISO 8601 date.

`smartlinks run` is the local dry-run: the same wrapper, QuickJS engine, and policies as
production, so what you test is what ships. Networking is off by default; opt in with
`--allow-network`, or use `--simulate` to trace a networked script's fetches and successful child
mints without sending anything. For browser-based iteration, `run --serve` serves the script on
`http://127.0.0.1:8787` (`--port` to change), re-reading and checking the root file on every root
request, never building a production link or contacting production. In serve mode, local
`ctx.compile` returns a clickable URL on that loopback server; compiled children and grandchildren
remain executable for the server session, including deliberately sealed delegation. One-shot
`run` uses clearly non-production `https://smartlinks.local/...` URLs and follows them in the same
process. Serve mode instead passes a directly returned child through as a 302, so the browser
navigates to the artifact it is executing, as it does in production. When scripting a multi-step
token flow across separate `run` processes, set the same high-entropy
`SMARTLINKS_LOCAL_TOKEN_KEY` for each.

Generated links are opaque bearer artifacts. `--copy` sends the link to the clipboard without
printing it; `--out link.txt` writes it with owner-only POSIX permissions. Both print only a
compact size, payload-budget, and SHA-256 fingerprint receipt — the fingerprint detects accidental
artifact drift, not authenticity. Plain `--json` includes the execution URL once.

Interstitials put a confirmation page between the click and the execution — use one for any
human-triggered side effect. The page separates immutable system guidance, an optional author
note, machine facts, and the decoded source. Notes are whitespace-normalized, limited to 140
Unicode characters, and public metadata; when a link contains sealed secrets, changing or removing
its note makes those secrets undecryptable.

## How the link works

1. The CLI type-checks TypeScript, transpiles it, safely minifies, optionally signs the complete
   artifact, raw-DEFLATE compresses it, and base64url-encodes the function body and metadata.
2. The runtime decodes the URL, verifies any author signature, rejects an expired execution, and
   opens any sealed secrets.
3. A fresh QuickJS sandbox runs the function with bounded memory, stack, execution, network,
   and body sizes.
4. The return value becomes the HTTP response.

The leading payload character identifies the format; current links use payload v2. Compile
closures live in compact optional v2 metadata and are displayed by `decode`. Payloads are capped
at 7,800 characters to remain comfortably below common URL limits.

## Know the boundary

Smartlinks are immutable bearer links, and the design is honest about what that means. Read this
section before putting authority into one.

- **Anyone with the URL can execute it.** There are no accounts, stored scripts, revocation
  lists, or per-link analytics. Expiry is the zero-infrastructure kill switch; gating execution
  on an endpoint you control is the immediate one.
- **Sealing hides a value, not the link.** A sealed secret stays out of the visible and decoded
  URL, but the running script is an oracle: anything its output depends on can be probed by
  exercising the link. Seal what the script never reflects back, and prefer narrowly scoped,
  revocable credentials.
- **Expiry without sealed secrets is advisory.** The Worker returns HTTP 410 after the deadline,
  but source is intentionally decodable, so someone can rebuild a public script without the
  deadline. Author signing makes such mutation attributable and detectable; it cannot prevent
  republishing as a different unsigned link.
- **Tokens are replayable.** Statelessness makes true once-only impossible; anything
  time-sensitive should carry its own timestamp.
- **Crawlers never execute.** Known crawler, prefetch, and `HEAD` requests receive a
  non-executing HTTP 200 preview carrying `x-smartlinks-preview: 1`, even after expiry — so a
  pasted link does not fire in chat unfurls. The header's presence confirms non-execution only on
  the immediate response from the configured runtime: disable redirect following and verify the
  response origin before trusting it. Absence alone does not prove execution.
- **Simulation is an authoring aid, not a safety verdict.** It exercises one deterministic path
  with no DNS lookup. Exact supplied secret values are redacted from its records; derived or
  transformed values cannot be recognized, so treat simulation output as potentially sensitive.
- **The runtime is bounded on purpose.** Fresh sandbox per request; guarded `fetch` blocks the
  runtime's own hostnames, local hostnames, private/local/reserved IP literals, cross-origin
  redirects, and oversized bodies (a Smartlink cannot invoke the runtime by HTTP — that is what
  `ctx.compile` is for). The hosted runtime might be rated limited; excess executions return HTTP 429.
  It is a carefully constrained service, run with production CI, deploy smoke tests, and no uptime SLA — and because the
  runtime is open and self-hostable, your links do not have to die with it.

## Self-hosting

The hosted runtime is a convenience, not a dependency. Deploy your own Worker and the same CLI
builds links against it — set `SMARTLINKS_URL` to your Worker URL.

For local Worker development:

```sh
cp .dev.vars.example .dev.vars
npm run build
node dist/index.js keygen --key-id 1
# Add the printed PRIVATE_KEY_1 value to .dev.vars
npm run dev
```

To deploy your own runtime, run `npx wrangler deploy`, then provision its key with the internal
`node dist/index.js keygen --key-id 1 --set-worker` command and set the token master secret with
`npx wrangler secret put TOKEN_MASTER_SECRET` (any long random string; without it, `ctx.crypto.seal`
without an explicit key fails). Keep `RUNTIME_HOSTNAMES` in `wrangler.jsonc` synchronized with
every public hostname that can reach the Worker. Never commit `.dev.vars`.

Self-hosted author certificates additionally require an issuer generated with the internal
`node dist/index.js author-keygen --key-id 128 --set-worker` command. Reserve issuer ID `1` for
hosted Smartlinks, choose an otherwise unused ID from `2` through `255`, and set that ID as the
runtime's `AUTHOR_CA_KEY_ID`. Put the public key in the corresponding configuration (for example,
`AUTHOR_CA_PUBLIC_KEY_128`) and set the matching CLI variable (for example,
`SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128`). Issuer IDs must be unique across every runtime a CLI is
configured to trust. The hosted Smartlinks identity service does not delegate its issuer key to
other runtimes.

## Build with an agent

The landing page's **Copy for agents** button copies a ready-made prompt. You can also point
your coding agent directly at the concise [Smartlinks agent guide](public/smartlinks-for-agents.md),
which describes the format, CLI, runtime contract, and limitations.

## Development

Smartlinks requires Node.js 24 or newer.

```sh
npm ci
npm run check
```

`npm run check` covers formatting, strict TypeScript, unit tests, Workers-runtime tests,
end-to-end tests of the built CLI, generated bindings, and a Wrangler production dry-run.

Pull requests run the full check. Merging a current, green PR to protected `main` deploys the
Worker and smoke-tests an expiring, sealed link against the live runtime; the same pre-merge checks
are not repeated after merge.
For a package release, run the **Release npm package** workflow and choose patch, minor, or major.
Open the release PR linked in the run summary, then merge it after CI passes. Publishing waits for
that exact merge commit's **Deploy Worker** workflow and production smoke test, then publishes to
npm and creates the tag and GitHub release. A manual `npx wrangler deploy` remains available for
production recovery.

---

<p align="center">
  <a href="https://smartlinks.jonaslsa.com">Turn the tiny program into the product.</a>
</p>
