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
| `ctx.method` | Incoming HTTP method |
| `ctx.headers` | Incoming headers with lowercase names |
| `ctx.body` | Request body as a string, or `null` |
| `ctx.secrets` | Decrypted plaintext values, keyed by secret name |
| `ctx.fetch(url, options)` | Guarded HTTP returning `{ status, headers, text }` |

Return an absolute URL for a `302` redirect, return `{ status?, headers?, body? }` for a response,
or return nothing for a small success page. Top-level `await` works.

## Sealed secrets

Secrets are encrypted locally with the runtime's public key and bound to the exact emitted
program. Only ciphertext and a key ID enter the URL.

```sh
export GITHUB_TOKEN=github_pat_…
smartlinks build examples/github-workflow-dispatch.js --secret GITHUB_TOKEN --copy
```

The private key stays in the Cloudflare Worker. This keeps a secret out of the visible and
decoded link, but it does not make the link private: anyone holding the complete URL can run
the program with that credential. Use narrowly scoped, revocable secrets.

## The CLI

```text
smartlinks build <script.js|script.ts>   Build an immutable execution and audit URL
smartlinks run <script.js|script.ts>     Run locally with the production sandbox
smartlinks decode <link-or-payload>      Inspect a Smartlink without executing it
```

Use `smartlinks --help` or `smartlinks help <command>` for every option. Useful build flags
include `--secret`, `--interstitial`, `--copy`, `--json`, `--no-minify`, and `--no-type-check`.
Local networking is off by default; opt in with `smartlinks run --allow-network`.

TypeScript input is strictly type-checked against the Smartlinks `ctx` and response contract,
then transpiled from the `.ts` extension before validation and encoding. Use `--no-type-check`
to explicitly skip semantic checking and only strip the types.

## How the link works

1. The CLI type-checks TypeScript, transpiles it, safely minifies, raw-DEFLATE compresses, and
   base64url-encodes the function body and metadata.
2. The runtime decodes the URL and opens any sealed secrets.
3. A fresh QuickJS sandbox runs the function with bounded memory, stack, execution, network,
   and body sizes.
4. The return value becomes the HTTP response.

The leading payload character versions the format so old links keep working as the codec
evolves. Payloads are capped at 7,800 characters to remain comfortably below common URL limits.

## Know the boundary

Smartlinks are immutable bearer links. There are no accounts, stored scripts, revocation lists,
or per-link analytics. The hosted runtime allows 60 executions per minute per client IP at each
Cloudflare location; excess executions return HTTP 429. Source code is intentionally decodable.
Use an interstitial for human-triggered side effects and scoped secrets for authenticated actions.

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
