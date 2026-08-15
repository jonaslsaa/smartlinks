# Smartlinks agent guide

Use this document as the operational contract when helping someone create a Smartlink.

## What Smartlinks is

[Smartlinks](https://github.com/jonaslsaa/smartlinks) turns a JavaScript or TypeScript function body into a self-contained executable URL.
The CLI transpiles TypeScript when the input filename ends in `.ts`, optionally minifies the
emitted JavaScript, validates the exact stored wrapper with QuickJS, seals requested secrets,
compresses the payload, and returns execution and decoder URLs. No script or per-link record is
stored by the service.

The execution URL carries the script and encrypted secret blobs. A Cloudflare Worker decodes the
payload, decrypts secrets, creates a fresh QuickJS runtime, supplies a small request context, and
maps the script's return value to an HTTP response.

## Authoring contract

Input files contain an async function body, not a module or complete function. Top-level `await`
and `return` are valid. Imports and Node APIs are unavailable inside QuickJS.

The script receives `ctx` with:

- `params`: query parameters excluding names beginning with `__`.
- `method`: the incoming HTTP method.
- `headers`: incoming headers with lowercase names.
- `body`: the request body as a string or `null`.
- `secrets`: decrypted values keyed by the names supplied during build.
- `fetch(url, options)`: guarded HTTP fetching that returns `{ status, headers, text }`.

Return an absolute HTTP(S) URL for a redirect, `{ status?, headers?, body? }` for a literal
response, or `undefined` for the default completion page.

TypeScript support is syntax transpilation, not project type-checking. Use the `.ts` extension to
enable it. The execution link and decoder contain emitted JavaScript. `--no-minify` still
transpiles TypeScript.

## CLI discovery

Smartlinks requires Node.js 18.18 or newer. In a fresh environment, check the runtime and CLI;
install the CLI from npm if it is unavailable:

- `node --version`
- `npm install --global @jonaslsa/smartlinks`
- `smartlinks --version`

Treat installed CLI help as authoritative:

- `smartlinks --help`
- `smartlinks help build`
- `smartlinks help run`
- `smartlinks help decode`
- `smartlinks help keygen`

There is no separate `compile` command. `build` performs transpilation, minification, compile-only
QuickJS validation, secret sealing, compression, and link creation without executing the guest
script. There is no command named `dry-run`; `run` is the local execution and validation path.

## `smartlinks build <script.js|script.ts>`

- `--interstitial`: require a browser confirmation before execution.
- `--secret NAME[=value]`: seal a secret; repeatable. Prefer environment values over inline values.
- `--service URL`: override the runtime used for public-key lookup and generated URLs.
- `--copy`: copy the execution URL.
- `--json`: emit machine-readable output only.
- `--no-minify`: skip JavaScript minification; TypeScript is still transpiled.

The command prints an execution URL and a non-executing decoder URL. It validates with QuickJS's
compile-only mode and never runs the script.

## `smartlinks run <script.js|script.ts>`

Use this as the local dry-run before building a final link.

- `--param NAME=value`: supply a query parameter; repeatable.
- `--secret NAME[=value]`: supply a local secret; repeatable.
- `--header NAME=value`: supply a request header; repeatable.
- `--method METHOD`: set the request method; defaults to `GET`.
- `--body TEXT`: set a request body; invalid for `GET` and `HEAD`.
- `--allow-network`: enable guarded `ctx.fetch`; networking is disabled by default locally.
- `--json`: emit the mapped response as machine-readable output.
- `--no-minify`: skip JavaScript minification; TypeScript is still transpiled.

Local execution uses the same wrapper, QuickJS engine, request-context normalization, general
URL/method/header/body/count/redirect policy, and response mapping as production.

## Other commands

`smartlinks decode <link-or-payload> [--json]` inspects the emitted script and metadata without
executing it or decrypting secrets.

`smartlinks keygen [--key-id ID] [--set-worker] [--json]` creates an X25519 HPKE key pair.
`--set-worker` sends the private bundle to `wrangler secret put` through stdin rather than printing
it. Existing private-key IDs must remain deployed while links still reference them.

Set `SMARTLINKS_URL` to change the default runtime without repeating `--service`.

## Secrets and authority

The CLI fetches the runtime's public key and encrypts each requested secret locally. Ciphertext is
bound to the active key ID and the exact emitted script, so it cannot be moved to a modified
script. The private key remains a Worker secret.

Encryption hides values from URL inspection; it does not make the execution URL private. Anyone
with the complete URL can invoke the script with its sealed authority. Prefer narrowly scoped,
revocable credentials. Avoid inline `NAME=value` secrets because shell history can retain them.

## Runtime and link limits

- Execution links are immutable and have no authentication, revocation list, rate limiting, or
  per-link analytics.
- Encoded payloads are limited to 7,800 characters. Raw and emitted source have a one-million-
  character wrong-file safety guard; minification and compression determine whether the URL fits.
- Each request gets a fresh QuickJS runtime with a 16 MiB heap, 512 KiB stack, deterministic
  1,500-interrupt-poll budget, and 15-second host-wait deadline. Interrupt polls are not CPU-time
  measurements.
- `ctx.fetch` permits HTTP(S), blocks local hostnames and private/local/reserved IP literals,
  limits same-origin redirects to three, total requests to five, request and response bodies to
  1 MiB, and each fetch to ten seconds. Cross-origin redirects are rejected. Local
  `smartlinks run --allow-network` additionally resolves and pins DNS connections to validated
  public addresses.
- Known crawler, preview, prefetch, and `HEAD` requests do not execute scripts. Detection is
  intentionally best-effort.
- Browser and intermediary URL limits vary; shorter links are preferable even below the hard cap.

Keep the script small, explicit, and least-privileged. Use `run` first, inspect the decoder output,
then use `build` for the final immutable link.
