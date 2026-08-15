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
  <a href="public/smartlinks-for-agents.md">Build with an agent</a>
</p>

---

Smartlinks is for the useful little bits of server-side logic that do not deserve a project,
a database, or a deployment pipeline.

A Smartlink can redirect to the latest release, turn parameters into an SVG badge, adapt one
webhook to another, or trigger an API with a sealed credential. The program lives in the URL;
a Cloudflare Worker decodes it, runs it in a fresh QuickJS sandbox, and turns the result into an
HTTP response. Smartlinks stores nothing.

## Make your first Smartlink

Install the CLI:

```sh
npm install --global @jonaslsa/smartlinks
```

Create `hello.ts`:

```ts
const name = ctx.params.name ?? "world";

return {
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: `Hello, ${name}!`,
};
```

Try it locally, then build the link:

```sh
smartlinks run hello.ts --param name=Jonas
smartlinks build hello.ts --copy
```

Open the copied URL with `?name=Jonas`. Pass the link to `smartlinks decode` to audit the exact
program without running it.

## What can a link do?

| Idea | Example |
| --- | --- |
| Follow the latest version of a project | [Smart redirect](examples/redirect.js) |
| Render a badge from query parameters | [SVG status badge](examples/badge.js) |
| Translate one webhook into another | [Webhook adapter](examples/webhook-adapter.js) |
| Trigger an authenticated action | [GitHub workflow dispatch](examples/github-workflow-dispatch.js) |
| Write the function body in TypeScript | [Typed response](examples/typed-response.ts) |

Smartlink scripts receive one small `ctx` object:

| Value | What it contains |
| --- | --- |
| `ctx.params` | Query parameters |
| `ctx.paramValues` | Every value for repeated query parameters |
| `ctx.method` | Incoming HTTP method |
| `ctx.headers` | Incoming headers with lowercase names |
| `ctx.body` | Request body as a string, or `null` |
| `ctx.secrets` | Decrypted plaintext values, keyed by secret name |
| `ctx.requestId` | Opaque ID for correlating one execution |
| `ctx.crypto` | SHA-256 and HMAC-SHA256 helpers backed by Web Crypto |
| `ctx.compile` | Mint one immutable child Smartlink from build-time-approved code |

Scripts also have a global, guarded `fetch(url, options)`. It accepts familiar string URL,
method, header, and string-body options and returns a Response-like value with `status`, `ok`,
`url`, `redirected`, `headers`, `text()`, and `json()`.

`ctx.crypto` provides `sha256`, `hmacSha256`, and `verifyHmacSha256`. They operate on strings,
use lowercase hex by default, and can use Base64 when passed `"base64"`.

Return an absolute URL for a `302` redirect, return `{ status?, headers?, body? }` for a response,
or return nothing for a small success page. Top-level `await` works.

## Mint a link from a link

A private parent Smartlink can mint one smaller, purpose-built child per execution. The CLI
extracts the child closure at build time; runtime values enter only through a typed positional
tuple:

```ts
const release = async (version: string) => ({
  body: `${version}:${ctx.secrets.RELEASE_TOKEN}`,
});

return ctx.compile(release, [ctx.params.version ?? "latest"], {
  ttlSeconds: 3600,
  seal: { RELEASE_TOKEN: ctx.secrets.RELEASE_TOKEN! },
});
```

Compile closures must be inline or top-level `const`/function declarations and cannot capture
outer variables; pass those values in the tuple instead. A child can carry its own statically
approved closures and mint another ordinary Smartlink—there is no stored link tree or generation
metadata.

`ttlSeconds` is optional and can never extend an existing parent expiry. `interstitial` may be
explicitly enabled or disabled; omission inherits the parent. `seal` accepts strings deliberately
chosen by the parent, whether directly delegated, derived, or generated. Parent links that expose
a mint path are unauthenticated administrative endpoints unless their own code verifies a request,
so keep them private or gate that branch cryptographically.

## Sealed secrets

Secrets are encrypted locally with the runtime's public key and bound to the complete immutable
program: its entry function, compile closures, baked child data, expiry, execution policy, and
secret name. Only ciphertext and a key ID enter the URL.

```sh
export GITHUB_TOKEN=github_pat_…
smartlinks build examples/github-workflow-dispatch.js --secret GITHUB_TOKEN --expires 7d --copy
```

The private key stays in the Cloudflare Worker. This keeps a secret out of the visible and
decoded link, but it does not make the link private: anyone holding the complete URL can run
the program with that credential until it expires. The expiry is cryptographically bound to
sealed secrets, so changing or removing it makes those secrets undecryptable. Use narrowly scoped,
revocable secrets.

Links without sealed secrets can also expire, but that expiry is advisory: because the source is
public, someone can decode it and build a new link without the deadline. Preventing that would
require a signed or stored payload, which Smartlinks deliberately does not have.

## The CLI

```text
smartlinks build <script.js|script.ts>   Build an immutable execution URL
smartlinks run <script.js|script.ts>     Run locally with the production sandbox
smartlinks decode <link-or-payload>      Inspect a Smartlink without executing it
```

Use `smartlinks --help` or `smartlinks help <command>` for every option. Useful build flags
include `--secret`, `--expires`, `--interstitial`, `--copy`, `--out`, `--json`, `--no-minify`,
and `--no-type-check`. `--expires` accepts a duration such as `30m`, `1h`, or `7d`, or an
absolute ISO 8601 date. Normal execution requests after that deadline return HTTP 410 without
running the script; crawler, prefetch, and `HEAD` requests remain non-executing HTTP 200 previews.
Local networking is off by default; opt in with `smartlinks run --allow-network`.
Local `ctx.compile` uses an ephemeral in-process key and a clearly non-production
`https://smartlinks.local/...` artifact. `run` follows compiled local links and executes their
final response in the same process, so dry-runs verify sealed delegation without publishing a
bearer link or needing the production private key.

Generated links are opaque bearer artifacts. `--copy` sends the link to the clipboard without
printing it, while `--out link.txt` writes it to a file with owner-only POSIX permissions; both
print only a compact size and payload-budget receipt. Plain `--json` includes the execution URL
once and omits the equivalent decoder URL. `smartlinks decode` accepts the execution URL directly.

TypeScript input is strictly type-checked against the Smartlinks `ctx`, global `fetch`, and
response contract, then transpiled from the `.ts` extension before validation and encoding. Use
`--no-type-check` to explicitly skip semantic checking and only strip the types.

## How the link works

1. The CLI type-checks TypeScript, transpiles it, safely minifies, raw-DEFLATE compresses, and
   base64url-encodes the function body and metadata.
2. The runtime decodes the URL, rejects an expired execution, and opens any sealed secrets.
3. A fresh QuickJS sandbox runs the function with bounded memory, stack, execution, network,
   and body sizes.
4. The return value becomes the HTTP response.

The leading payload character identifies the format; current links use payload v2. Compile
closures live in compact optional v2 metadata and are displayed by `decode`. Payloads are
capped at 7,800 characters to remain comfortably below common URL limits.

## Know the boundary

Smartlinks are immutable bearer links. They can have a build-time expiry, but there are no
accounts, stored scripts, revocation lists, or per-link analytics. The hosted runtime allows 60
executions per minute per client IP at each Cloudflare location; excess executions return HTTP
429. Source code is intentionally decodable. Use an interstitial for human-triggered side effects
and scoped secrets for authenticated actions.

The runtime blocks local hostname suffixes, private/local/reserved IP literals, cross-origin
redirects, and oversized bodies. Local `run --allow-network` is stricter: it also resolves and
pins DNS connections to validated public addresses. Known crawler, prefetch, and `HEAD` requests
do not execute scripts. This is a carefully constrained hobby service, not a general-purpose
hostile-code platform.

## Build with an agent

The landing page's **Copy for agents** button copies a ready-made prompt. You can also point
your coding agent directly at the concise [Smartlinks agent guide](public/smartlinks-for-agents.md),
which describes the format, CLI, runtime contract, and limitations.

## Development

Smartlinks requires Node.js 18.18 or newer.

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

## Self-hosting

For local Worker development:

```sh
cp .dev.vars.example .dev.vars
npm run build
node dist/index.js keygen --key-id 1
# Add the printed PRIVATE_KEY_1 value to .dev.vars
npm run dev
```

To deploy your own runtime, run `npx wrangler deploy`, then provision its key with the internal
`node dist/index.js keygen --key-id 1 --set-worker` command. Set `SMARTLINKS_URL` to the new
Worker URL when building links. Never commit `.dev.vars`.

---

<p align="center">
  <a href="https://smartlinks.jonaslsa.com">Turn the tiny program into the product.</a>
</p>
