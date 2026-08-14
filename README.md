# Smartlinks

Smartlinks turns a small JavaScript program into a self-contained URL. The URL is the
deployment: query parameters become inputs, a fresh QuickJS sandbox runs the script on a
Cloudflare Worker, and the return value becomes the HTTP response. There are no accounts,
database records, or stored scripts.

Runtime: <https://smartlinks-runtime.jonasvox-2014.workers.dev>
Landing page: <https://smartlinks-coral.vercel.app>

## Quick start

Install the TypeScript CLI directly from GitHub:

```sh
npm install -g github:jonaslsaa/smartlinks
```

Create `hello.js`. Smartlink scripts are async function bodies, so top-level `await` and
`return` both work:

```js
return {
  body: `Hello, ${ctx.params.name ?? "world"}!`,
  headers: { "content-type": "text/plain; charset=utf-8" },
};
```

Build and try it:

```sh
smartlinks build hello.js --copy
# Open the copied URL with ?name=Jonas appended.
```

The CLI also prints a `/d/…` audit URL that decodes the script without running it. Add
`--interstitial` when the execution link itself should show the decoded script and require
an explicit confirmation POST before running.

## Script API

Every script receives one plain `ctx` object:

```js
ctx.params; // query parameters, excluding names beginning with __
ctx.method; // incoming HTTP method
ctx.headers; // incoming headers with lowercase names
ctx.body; // request body as a string, or null
ctx.secrets; // decrypted secrets by name
ctx.fetch(url, options); // guarded outbound fetch
```

`ctx.fetch` accepts `http:` and `https:` URLs and returns a plain
`{ status, headers, text }` object. It blocks local/private/reserved IP literals and local
hostnames; the local CLI additionally pins DNS resolution to validated public addresses.
Cross-origin redirects are rejected so authorization headers and bodies cannot move to a
different service. Same-origin redirects are limited to three, total requests to five, and
request/response bodies to 1 MB measured as UTF-8 bytes.

The script may return:

- An absolute `http:` or `https:` URL string for a `302` redirect.
- `{ status?, headers?, body? }` for a literal response.
- `undefined` for the default `✓ done` page.

See the ready-to-build examples:

- [Smart redirect](examples/redirect.js)
- [SVG status badge](examples/badge.js)
- [Webhook adapter](examples/webhook-adapter.js)
- [GitHub workflow dispatch](examples/github-workflow-dispatch.js)

## Sealed secrets

Yes: the CLI encrypts secrets with the runtime's **public key**. The private key is
generated locally, stored as a Cloudflare Worker secret, and never embedded in a
smartlink.

```sh
export GITHUB_TOKEN=github_pat_…
smartlinks build examples/github-workflow-dispatch.js --secret GITHUB_TOKEN
```

For `--secret NAME`, the CLI uses `$NAME` or asks with a hidden TTY prompt. You can also use
`--secret NAME=value`, but that puts the plaintext in shell history and is usually the wrong
choice.

The complete flow is:

1. The CLI fetches the current key ID and X25519 public key from `/pk`.
2. It HPKE-encrypts each value with X25519, HKDF-SHA-256, and AES-128-GCM.
3. The authenticated associated data is the key ID plus the SHA-256 hash of the exact stored
   script. Moving the ciphertext to a changed or different script makes decryption fail.
4. Only the ciphertext and key ID are placed in the URL. At execution time, the Worker uses
   its `PRIVATE_KEY_<id>` secret to decrypt the values immediately before entering QuickJS.

Encryption protects the value from people inspecting or decoding the URL; it does **not**
make the link private. Anyone holding the complete execution URL can trigger its script with
the sealed credentials. Use narrowly scoped, revocable credentials and opt into the
interstitial for human-triggered side effects.

## CLI reference

```text
smartlinks build <script.js>
  [--interstitial]
  [--secret NAME[=value] ...]
  [--service URL]
  [--copy]
  [--json]
  [--no-minify]

smartlinks decode <link-or-payload> [--json]

smartlinks run <script.js>
  [--param NAME=value ...]
  [--secret NAME[=value] ...]
  [--header NAME=value ...]
  [--method METHOD]
  [--body TEXT]
  [--allow-network]
  [--json]
  [--no-minify]

smartlinks keygen [--key-id 1] [--set-worker] [--json]
```

`smartlinks build` compile-checks the exact production wrapper with QuickJS's `compileOnly`
mode and discards the temporary bytecode; it never executes the script. `smartlinks run` is
the explicit local execution command and uses the same codec, guarded fetch implementation,
response mapper, wrapper, and QuickJS engine as production. Its network bridge stays disabled
unless `--allow-network` is present. Set `SMARTLINKS_URL` to override the baked-in runtime
without repeating `--service`.

## Encoding and link length

Payload version 2 first minifies the complete async function with Terser, stores it in a
short-key JSON envelope, applies raw DEFLATE level 9, then uses unpadded base64url. The first
URL character is the payload version. Links are rejected above 7,800 payload characters.

A Base85/Base86-style encoding looks denser in isolation, but most additional alphabet
characters are reserved or inconsistently handled in URLs. Once those characters are
percent-encoded, the result is commonly longer and more fragile. Unpadded base64url is the
best simple portable choice here. Version 1 decoding remains unchanged for old links.

For tiny scripts the compression header/metadata can dominate; for realistic scripts,
minification plus DEFLATE wins. Use `--no-minify` only when preserving the stored source is
more valuable than link length.

## Safety and limitations

- Links are immutable. A bug requires creating and distributing a new URL.
- Anyone with an execution URL can run it, repeatedly. There is no authentication, rate
  limiting, revocation list, or per-link analytics in v1.
- Secrets are encrypted, but the Worker necessarily decrypts them while executing the bound
  script. Prefer least-privilege credentials with independent expiry/revocation.
- QuickJS provides a separate guest runtime with a 16 MB heap, 512 KB stack, a deterministic
  1,500-interrupt-poll budget, and 15-second host-wait deadline. Interrupt polls are not
  calibrated to CPU milliseconds, and external latency is not a measurement of Workers CPU
  usage. It is a meaningful isolation boundary, not a promise that arbitrary hostile programs
  are harmless. The [deployed engine spike](docs/engine-spike.md)
  records why v1 uses original QuickJS rather than QuickJS-NG.
- Outbound fetch restrictions are intentionally small and best-effort. This is a hobby
  service, not a general-purpose untrusted-code platform.
- Slack, Discord, social crawlers, `HEAD`, and explicit prefetch requests receive a no-op
  preview. Blocklists can never identify every future crawler.
- Browser and intermediary URL limits vary. Smartlinks enforces a conservative payload cap,
  but shorter remains better.

## Development

Requires Node.js 18.18 or newer.

```sh
npm ci
npm run build
npm test
npm run check
```

`npm test` runs both ordinary Vitest tests and integration tests inside Cloudflare's Workers
runtime. `npm run check` additionally runs Biome, strict TypeScript checks, generated binding
checks, and a real Wrangler production dry-run.

For local Worker development:

```sh
cp .dev.vars.example .dev.vars
node dist/index.js keygen --key-id 1
# Put the printed value after PRIVATE_KEY_1= in .dev.vars.
npm run dev
```

Never commit `.dev.vars`; it is ignored.

## Deploying and rotating keys

The repository contains one Worker and no storage bindings:

```sh
npx wrangler deploy
node dist/index.js keygen --key-id 1 --set-worker
```

`--set-worker` sends the generated private/public key bundle directly to
`wrangler secret put PRIVATE_KEY_1`; it does not print the private value. `/pk` derives the
public response from that secret.

To rotate, generate and store the next ID first, change `ACTIVE_KEY_ID` in `wrangler.jsonc`,
then deploy. Keep every older `PRIVATE_KEY_<id>` secret that is still referenced by a live
link. Removing an old key deliberately makes those links unable to decrypt their secrets.

The routes are:

| Route | Purpose |
| --- | --- |
| `GET /` | Runtime health and metadata |
| `ALL /r/<payload>` | Preview, confirm if requested, decrypt, and execute |
| `GET /d/<payload>` | Decode and audit without executing |
| `GET /pk` | Current public encryption key and key ID |
