# Smartlinks agent guide

Use this document as the operational contract when helping someone create a Smartlink.

## What Smartlinks is

[Smartlinks](https://github.com/jonaslsaa/smartlinks) turns a JavaScript or TypeScript function body into a self-contained executable URL.
The CLI strictly type-checks TypeScript against the Smartlinks runtime contract when the input
filename ends in `.ts`, transpiles it, optionally minifies the emitted JavaScript, validates the
exact stored wrapper with QuickJS, seals requested secrets, compresses the payload, and returns
an execution URL. No script or per-link record is stored by the service.

The execution URL carries the script and encrypted secret blobs. A Cloudflare Worker decodes the
payload, decrypts secrets, creates a fresh QuickJS runtime, supplies a small request context, and
maps the script's return value to an HTTP response.

## Authoring contract

Input files contain an async function body, not a module or complete function. Top-level `await`
and `return` are valid. Imports and Node APIs are unavailable inside QuickJS.

The script receives `ctx` with:

- `params`: query parameters excluding names beginning with `__`.
- `paramValues`: every value for repeated query parameters, excluding reserved names.
- `method`: the incoming HTTP method.
- `headers`: incoming headers with lowercase names.
- `body`: the request body as a string or `null`.
- `secrets`: decrypted values keyed by the names supplied during build.
- `requestId`: an opaque per-execution correlation ID.
- `crypto`: SHA-256, HMAC-SHA256, and constant-time HMAC verification helpers.
- `compile`: mint one child Smartlink from a statically packaged closure.

`ctx.crypto.sha256(message, encoding?)`, `hmacSha256(key, message, encoding?)`, and
`verifyHmacSha256(key, message, signature, encoding?)` accept strings. Encoding defaults to
lowercase `hex`; `base64` is also supported. An execution may perform at most 16 cryptographic
operations, with at most 1 MiB of string input per operation.

Global `fetch(url, options)` accepts a string URL, method, plain headers, and a string body. It
returns a Response-like value with `status`, `statusText`, `ok`, `url`, `redirected`, `headers`,
`bodyUsed`, `text()`, and `json()`. The response body can be consumed once. Streams, `Request`,
`Blob`, `FormData`, cloning, custom redirect modes, and guest abort signals are not supported.

Return an absolute HTTP(S) URL for a redirect, `{ status?, headers?, body? }` for a text response,
`{ status?, headers?, bodyBase64 }` for bytes, or `undefined` for the default completion page.
`body` and `bodyBase64` are mutually exclusive. `bodyBase64` accepts standard padded or unpadded
Base64, is limited to 1 MiB after decoding, and defaults to `application/octet-stream` when the
headers do not supply a content type. `content-disposition` remains author-controlled.

### Runtime compilation

`ctx.compile(closure, args, options?)` returns a child execution URL. `args` is a positional JSON
tuple whose TypeScript types must match the closure parameters. The closure must be inline or a
top-level `const`/function declaration and may use its parameters, `ctx`, `fetch`, and supported
JavaScript globals, but it cannot capture other outer variables. Pass runtime values explicitly in
the tuple. The CLI extracts and type-checks every closure before minification, replaces the guest
reference with an internal table index, and packages the finite closure table in the link.

Options are:

- `ttlSeconds?: number`: optional positive integer seconds. The child deadline is
  `min(now + ttlSeconds, parent notAfter)`; omission inherits the parent deadline, and a parent
  without a deadline may mint a child without one. Children shared outside the parent's audience
  should usually expire; prefer hours, not days.
- `interstitial?: boolean`: explicit `true` or `false` overrides the parent; omission inherits it.
- `seal?: Record<string, string>`: strings to encrypt for the child's `ctx.secrets`. Direct parent
  secrets, deliberately derived values, and generated values are all supported.

One `ctx.compile` attempt is allowed per execution, including failed attempts. Tuple data is
canonical JSON with a 64 KB encoded limit, 32-level depth limit, 10,000-value limit, and no
`__proto__` keys. The runtime rejects any decrypted parent-secret bytes found in child source,
packaged closures, or tuple data; move intentional delegation through `seal`. Each sealed value
also consumes one of the execution's 16 shared cryptographic operations.

A child carrying another build-time-approved closure may mint another ordinary Smartlink. There
is no stored ancestry, generation counter, or depth policy. Each execution independently reapplies
the same one-mint budget, validation, expiry resolution, sealing, and payload limits.

A parent whose mint branch is reachable by anyone holding its URL is an unauthenticated admin
endpoint. Keep parent links private or make their code verify a signed request before compiling.

A literal response can be a complete HTML document. The script cannot read its own URL, but
relative references resolve against it, so `href="?q=value"` and a bare `<form method=get>` re-enter
the same link with new parameters; add `cache-control: no-store` when each execution should differ.
Escape every interpolated value, since query parameters and fetched data are attacker-controlled.

TypeScript is checked in isolation with strict compiler settings and built-in types for `ctx`,
global `fetch`, and valid script results. Smartlinks does not load a project `tsconfig` or resolve
imports. The execution link and decoder contain emitted JavaScript. `--no-type-check` skips
semantic checking but still transpiles TypeScript; `--no-minify` still transpiles it as well.

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

There is no separate `compile` command. `build` performs TypeScript checking and transpilation,
minification, compile-only QuickJS validation, secret sealing, compression, and link creation
without executing the guest script. There is no command named `dry-run`; `run` is the local
execution and validation path.

## `smartlinks build <script.js|script.ts>`

- `--interstitial`: require a browser confirmation before execution.
- `--secret NAME[=value]`: seal a secret; repeatable. Prefer environment values over inline values.
- `--expires VALUE`: expire the link after a duration (`30m`, `1h`, `7d`) or at an absolute ISO
  8601 date. The CLI stores the deadline as integer Unix seconds in UTC and rejects past dates.
  Normal execution requests after it return HTTP 410; crawler, prefetch, and `HEAD` requests remain
  non-executing HTTP 200 previews.
- `--copy`: copy the execution URL and print only a compact size receipt.
- `--out FILE`: write the execution URL to a file and print only a compact size receipt. New and
  existing output files are set to owner-only permissions on POSIX systems.
- `--json`: emit machine-readable output only.
- `--no-type-check`: skip strict semantic checking for TypeScript; syntax must still transpile.
- `--no-minify`: skip JavaScript minification; TypeScript is still transpiled.

The command produces an execution URL. Plain `--json` includes that URL once and omits the
equivalent decoder URL. Pass the execution URL or raw payload to `smartlinks decode` for
inspection. If a browser decoder URL is specifically needed, replace the execution URL's first
`/r/` path segment with `/d/`. `build` validates with QuickJS's compile-only mode and never runs
the script.

### Treat the generated link as a compiled artifact

The execution URL is token-heavy, opaque, and carries bearer authority. Treat it like a compiled
binary rather than prose: do not repeat it to the user or copy it into reasoning, plans, or other
working context. Use `run` while iterating, then prefer `build --out link.txt` when an agent needs
to compile and check the encoded size. Keep that file out of version control. Use `--copy` when
the user should receive the final link directly; if clipboard access is unavailable, ask the user
to run the final command rather than printing the URL. Both modes suppress the URL and report its
character count, payload version, and budget usage instead.

When an expiry is present, the receipt also states its absolute UTC timestamp.

## `smartlinks run <script.js|script.ts>`

Use this as the local dry-run before building a final link.

- `--param NAME=value`: supply a query parameter; repeatable.
- `--secret NAME[=value]`: supply a local secret; repeatable.
- `--header NAME=value`: supply a request header; repeatable.
- `--method METHOD`: set the request method; defaults to `GET`.
- `--body TEXT`: set a request body; invalid for `GET` and `HEAD`.
- `--allow-network`: enable guarded `fetch`; networking is disabled by default locally.
- `--json`: emit the mapped response as machine-readable output.
- `--no-type-check`: skip strict semantic checking for TypeScript; syntax must still transpile.
- `--no-minify`: skip JavaScript minification; TypeScript is still transpiled.

Local execution uses the same wrapper, QuickJS engine, request-context normalization, general
URL/method/header/body/count/redirect policy, response mapping, and compile validation as
production. Local compile sealing uses an ephemeral in-process keypair and returns a local-only
`https://smartlinks.local/r/<payload>` URL. `run` follows compiled local links, decrypts them with
that ephemeral key, and executes the final response in the same process, with a ten-hop local
follow limit. It does not contact `/pk`, use production private-key material, or publish a durable
bearer link.
For binary responses, `--json` emits `bodyBase64` instead of a lossy text body. Redirected plain
stdout receives the exact bytes; an interactive terminal prints a byte-count receipt rather than
writing binary data to the terminal.

## Other commands

`smartlinks decode <link-or-payload> [--json]` inspects the emitted script and metadata without
executing it or decrypting secrets. It renders `notAfter` as an absolute UTC timestamp and marks
links whose deadline has passed.

## Secrets and authority

The CLI fetches the runtime's public key and encrypts each requested secret locally. Ciphertext is
bound to the active key ID, target secret name, and complete immutable authority-bearing artifact:
the entry script, ordered compile table, baked program data, expiry, and execution-policy flags.
Changing any of those fields makes decryption fail. Dynamic request parameters remain variable
input to the authenticated program and are not part of this binding. The private key remains a
Worker secret.

Encryption hides values from URL inspection; it does not make the execution URL private. Anyone
with the complete URL can invoke the script with its sealed authority until `notAfter`, when
present. Prefer narrowly scoped, revocable credentials. Avoid inline `NAME=value` secrets because
shell history can retain them. If there is a frontend, be careful not to leak secrets to the client.

`notAfter` is cryptographically bound to sealed secrets. Altering or removing it from a sealed
payload makes those secrets fail to decrypt. On a link without sealed secrets, expiry is advisory:
the Worker still returns HTTP 410 for normal execution requests after the deadline, but anyone can
decode the public source and build a separate link without that deadline.

## Runtime and link limits

- Execution links are immutable and have no authentication, revocation list, or per-link
  analytics. An optional `notAfter` deadline is checked before sandbox execution; normal expired
  executions return HTTP 410. The hosted runtime is rate-limited for fair-use of this service;
  excess executions return HTTP 429.
- Encoded payloads are limited to 7,800 characters. Raw and emitted source have a one-million-
  character wrong-file safety guard; minification and compression determine whether the URL fits.
- Each request gets a fresh QuickJS runtime with a 16 MiB heap, 512 KiB stack, deterministic
  1,500-interrupt-poll budget, and 15-second host-wait deadline. Interrupt polls are not CPU-time
  measurements.
- One `ctx.compile` attempt is allowed per execution on the hosted Workers Free runtime. This
  separate limit was chosen from production CPU measurements; a second near-limit sealed mint
  crossed the platform CPU boundary.
- `fetch` permits HTTP(S), blocks Smartlinks runtime hostnames, local hostnames, and
  private/local/reserved IP literals, limits same-origin redirects to three, total requests to
  five, request and response bodies to 1 MiB, and each fetch to ten seconds. A Smartlink cannot
  invoke the runtime by HTTP; use `ctx.compile` to create a child link. Cross-origin redirects are rejected. Local
  `smartlinks run --allow-network` additionally resolves and pins DNS connections to validated
  public addresses.
- Known crawler, preview, prefetch, and `HEAD` requests do not execute scripts. Detection is
  intentionally best-effort.
- Browser and intermediary URL limits vary; shorter links are preferable even below the hard cap.

## Budgeting the payload

The 7,800-character limit applies to the compressed payload, not to the source, so the practical
ceiling is much higher than it suggests and depends on what a script contains rather than how long
it is. Minification renames locals and strips formatting; compression collapses repetition. Neither
shrinks unique string data.

| Script content                                    | Source that still fits | Ratio      |
| ------------------------------------------------- | ---------------------- | ---------- |
| Logic: functions, branches, local names            | ~75,000 characters     | 6x to 10x  |
| Markup: inline HTML and CSS in template literals   | ~45,000 characters     | 3x to 6x   |
| Unique string data: word lists, tables, literals   | ~11,000 characters     | about 1.4x |

Ratios improve as scripts grow, so small scripts understate the headroom: the same markup shape
measures 2.8x at 1,900 source characters and 5.8x at 27,000. A full HTML page with inline CSS,
escaping, and a fetch call lands near 2,500. Write readable code rather than golfing it, keep bulk
data out of the payload, and read the size and budget percentage printed by `build --out FILE` or
`build --copy` instead of estimating.

Keep the script explicit and least-privileged; size is a payload question rather than a design
constraint. Use `run` first, inspect with `decode`, then use `build --out link.txt` or
`build --copy` for the final immutable link. IF it is safe to test it, then smoke-test it to see if
it works while you work.
