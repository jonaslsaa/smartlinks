# Smartlinks agent guide

Operational contract for creating Smartlinks.

## What Smartlinks is

[Smartlinks](https://github.com/jonaslsaa/smartlinks) turns a JavaScript or TypeScript function
body into a self-contained executable URL. The CLI strictly type-checks TypeScript against the
runtime contract when the input filename ends in `.ts`, transpiles it, optionally minifies,
validates the exact stored wrapper with QuickJS, seals requested secrets, compresses the payload,
and returns an execution URL. The service stores no script or per-link record: the URL carries
everything, including encrypted secret blobs. A Cloudflare Worker decodes it, decrypts secrets,
runs the script in a fresh QuickJS runtime with a small request context, and maps the return
value to an HTTP response.

An optional author signature is also self-contained: `smartlinks login` verifies GitHub once,
creates a dedicated local Ed25519 key, and receives a compact Smartlinks certificate. Building,
decoding, previewing, and executing signed links make no GitHub request.

## Authoring contract

Input files contain an async function body — not a module or complete function. Top-level `await`
and `return` are valid. Imports, Node APIs, timers, `TextEncoder`, and `Intl` are unavailable
inside QuickJS; `Date.now()` works.

The script receives `ctx` with:

- `params`: query parameters, excluding names beginning with `__`. A parameter present with no
  value (`?a=`) is the empty string, not absent — validate before coercing, since `Number("")` is
  `0`.
- `paramValues`: every value for repeated query parameters, same exclusion.
- `method`: the incoming HTTP method.
- `headers`: incoming headers with lowercase names; `cookie` is omitted.
- `body`: the request body as a string or `null`.
- `secrets`: decrypted values keyed by the names supplied to `build` or `run`. In top-level
  TypeScript, supplied names are required string properties, so misspellings fail type checking.
  With no supplied names, and inside compiled child contexts, access remains `string | undefined`.
- `requestId`: an opaque per-execution correlation ID.
- `crypto`: `sha256(message, encoding?)`, `hmacSha256(key, message, encoding?)`,
  `verifyHmacSha256(key, message, signature, encoding?)` (constant-time),
  `random(byteCount, encoding?)` drawing up to 256 bytes of host entropy, and the `seal`/`open`
  token helpers below. Inputs are strings; encoding is lowercase `hex` (default) or `base64`.
  At most 16 cryptographic operations per execution, and 1 MiB of string input per hashing or HMAC
  operation. `ctx.compile` draws on this budget only through `seal`, one per value; its own
  one-attempt limit is separate.
- `compile`: mint one child Smartlink from a statically packaged closure.

Prefer deriving values with `hmacSha256(ctx.secrets.KEY, ctx.requestId + counter)` when the link
already holds a sealed key; use `random` when it must originate a fresh secret — `Math.random` is
not cryptographically secure. Simulation substitutes a reproducible stream for explicit `random`
calls, with distinct bytes on successive calls across the whole simulated parent/child chain.
Browser-compatible globals `btoa(value)` and `atob(value)` encode and decode Latin-1 binary
strings — the standard Base64 that `bodyBase64` accepts.

Global `fetch(url, options)` accepts a string URL, method, plain headers, and a string body, and
returns a Response-like value with `status`, `statusText`, `ok`, `url`, `redirected`, `headers`
(read via `.get(name)`, unlike the plain-object request headers), `bodyUsed`, `text()`, and
`json()`; the body can be consumed once. Streams, `Request`, `Blob`,
`FormData`, cloning, custom redirect modes, and guest abort signals are not supported.

Return an absolute HTTP(S) URL for a 302 redirect (return `{ status, headers }` with a `location`
header for any other redirect status), `{ status?, headers?, body? }` for text,
`{ status?, headers?, bodyBase64 }` for bytes, or `undefined` for the default completion page.
For an interstitial Smartlink, cross-origin 307/308 redirects are rejected; return a 303 or a
bare URL for navigation.
`body` and `bodyBase64` are mutually exclusive. `bodyBase64` accepts padded or unpadded Base64,
is limited to 1 MiB after decoding, and defaults to `application/octet-stream` when headers do
not supply a content type; `content-disposition` remains author-controlled. Every authored
response receives `X-Content-Type-Options: nosniff` and the artifact's authenticated browser
policy. An author CSP is enforced as an additional policy, so it may tighten but cannot weaken the
runtime floor; CSP reporting directives and browser reporting headers are removed because reports
would disclose the bearer URL outside the browser policy. Other headers remain author-controlled
except `set-cookie`, `clear-site-data`, `x-smartlinks-preview`, and CORS response headers. Those
boundaries are runtime-owned: an executed response cannot spoof preview status, acquire cookie
state, or opt itself into CORS.

A response can be a complete HTML document. Guest execution does not receive the current request
URL directly, and the default `no-referrer` policy keeps it unavailable. Relative references still
resolve against it, so `href="?q=value"` and a bare `<form method=get>` re-enter the same link with
new parameters; add `cache-control: no-store` when each execution should differ. `referrer: full`
deliberately exposes the previous page's complete URL to eligible later requests through
`ctx.headers.referer` or `document.referrer`. To display or hand out a fresh absolute working URL,
mint a child with `ctx.compile` — the only current execution URL the runtime supplies — at the cost
of its single mint. Escape every interpolated value: query parameters and fetched data are
attacker-controlled.

### Browser policy

Authored responses always run under CSP `sandbox` without `allow-same-origin`. Inline scripts and
styles, dynamic JavaScript and Wasm, data/blob assets and workers, forms back to the runtime,
user-activated navigation, downloads, dialogs, and popups work by default. The opaque origin means
cookies, persistent storage, service workers, and DOM access between Smartlinks remain unavailable
even though they share a hostname. Runtime-owned previews, interstitials, errors, decoder pages,
and the default completion page keep their separate strict non-executing policy.

External boundaries are stored in the artifact's `browser` policy and shown by `decode`. Each
source is `self`, `https`, `all`, or an exact HTTPS origin without a path or credentials. `self`
is emitted as the explicit runtime origin because the page itself has an opaque origin; `https`
allows any HTTPS origin; `all` is unrestricted and is the only embedding value that also matches
opaque Smartlink parents. Fields are `scripts`, `connect`, `images`,
`styles`, `fonts`, `media`, `frames`, `forms`, `embeddableBy`, and `referrer` (`none`, `origin`, or
`full`). Omitted external fields allow nothing. Omitted `embeddableBy` makes the response
nonembeddable; an author-supplied framing header may further restrict an embeddable artifact.

`cors: true` makes the artifact a credential-free cross-origin target: the runtime owns wildcard
CORS response headers and answers valid preflights before rate limiting or guest execution. It
does not let the page initiate a request; the calling artifact separately needs the target in
`browser.connect`. Opaque Smartlink pages send `Origin: null`, so origin-specific credentialed
CORS is deliberately unavailable until artifacts have distinct origins.

TypeScript is checked in isolation with strict compiler settings and built-in types for `ctx`,
global `fetch`, and valid script results — no project `tsconfig`, no import resolution. The link
and decoder contain emitted JavaScript. `--no-type-check` skips semantic checking; it and
`--no-minify` both still transpile TypeScript.

### Stateless tokens

`ctx.crypto.seal(value, options?)` encrypts any JSON value into an opaque base64url token;
`ctx.crypto.open(token, options?)` authenticates it and returns the value, throwing on any
tampered, truncated, foreign, or mismatched token. Each call is one cryptographic operation.
Tokens let a link hand the client state the client can neither read nor forge, and recover it on
a later request.

Without options, a token is bound to the exact artifact: identical script, closures, expiry,
interstitial, crawler-execution and browser policy, CORS choice, author note, authority, and
sealed-secret ciphertexts.
Rebuilding with any change (including rebuilding the same secrets, whose sealing uses fresh
randomness) rotates the key and invalidates outstanding tokens by design; children minted with
`ctx.compile` are distinct artifacts and never share transparent tokens with their parent.

`options.key` (a string of at least 16 bytes) skips artifact binding, so tokens survive rebuilds
and cross between cooperating links: generate the key once and supply it to both builds through
the environment (`export VOUCHER_KEY=$(openssl rand -base64 32)`, then `--secret VOUCHER_KEY` on
each). `--secret NAME=@random` instead seals a fresh 32-byte key that nobody, including the
author, ever sees; each build generates its own, so it suits keys passed only downward to
`ctx.compile` children via `seal`, never keys two builds must agree on.
`options.context` domain-separates tokens: a token sealed with `{ context: "cooldown" }` opens
only with that context.

Tokens are replayable — statelessness makes true once-only impossible. Patterns that care embed a
timestamp in the value and check it after opening. Local executions derive tokens from an
ephemeral per-process key by default. For a scripted multi-process walkthrough, set the same
high-entropy `SMARTLINKS_LOCAL_TOKEN_KEY` (at least 16 bytes) on every `run`; alternatively use
`run --serve`, whose key is stable for the server session. Tokens remain bound to the exact
artifact. Transparent local tokens never interoperate with production; tokens using an explicit
`options.key` remain intentionally portable between runtimes. Behavior is otherwise identical.

The canonical shape — a wizard whose whole session lives in one query parameter:

```ts
const state = ctx.params.s
  ? await ctx.crypto.open<{ step: number; answers: string[] }>(ctx.params.s, { context: "wizard" })
  : { step: 1, answers: [] };
const next = await ctx.crypto.seal({ ...state, step: state.step + 1 }, { context: "wizard" });
```

The same pair covers a **hidden answer** sealed into the link's own URL and compared against a
guess, a **cooldown** that seals `Date.now()` so the client carries its own rate-limit timer, and
a **voucher** one link issues and a different link redeems via a shared `options.key`:

```ts
const claim = await ctx.crypto.open(ctx.params.v!, { key: ctx.secrets.VOUCHER_KEY });
```

### Runtime compilation

`ctx.compile(closure, args, options?)` returns a child execution URL. The closure's first
parameter is the child execution context, supplied by the runtime — annotate it
`SmartlinksContext` on a named TypeScript closure; inline closures are contextually typed.
`typeof ctx` also works when the child inherits the root's secret shape; use `SmartlinksContext`
when it receives a different delegated set. `args` is a positional JSON tuple whose TypeScript
types must match the remaining closure parameters. The closure must be inline or a top-level
`const`/function declaration. When a self-recursive closure and packaged helper form a
TypeScript inference cycle, annotate the closure's return type as `Promise<SmartlinksResult>`. It
may call transitively packaged top-level helpers and read immutable primitive constants. Eligible
constants are strings, numbers, bigints, booleans,
`null`, or template literals without expressions. Eligible helpers are unmodified function
declarations, `const` arrows, or anonymous `const` function expressions; they may use parameters,
locals, supported globals, and other eligible declarations, but never the parent's `ctx`.
Dependency helpers cannot access any `.compile` property; keep minting calls directly inside the
compile closure. Ordinary function helpers cannot use `arguments`; declare parameters or a rest
parameter instead. Other parent values must be passed explicitly in the tuple.

Packaged helpers are copied definitions, not mutable runtime function objects. Every reference
outside a direct `ctx.compile` closure position must therefore call the helper directly: passing,
inspecting, comparing, or mutating it is rejected. Named function expressions, objects, arrays,
classes, computed initializers, and mutable declarations are not packaged. The CLI resolves exact
lexical bindings transitively, preserves declaration order, extracts and type-checks every closure
before minification, replaces guest closure references with table indexes, and packages the finite
closure table in the link. Call `ctx.compile(...)` directly so the build can identify the call
site; the method cannot be aliased, destructured, or passed as a value.

Compile arguments are data. Never evaluate them, pass them to `Function`, or interpolate them
into executable source: static closure extraction authenticates the authored interpreter; it
cannot make that interpreter safe to feed untrusted code.

Options:

- `ttlSeconds?: number` — positive integer seconds; the child deadline is
  `min(now + ttlSeconds, parent notAfter)`, or plain `now + ttlSeconds` when the parent has no
  deadline. Omission inherits the parent deadline, and a parent without one may mint a child
  without one.
- `interstitial?: boolean` — explicit value overrides the parent; omission inherits.
- `allowCrawlers?: boolean` — allow known crawler and image-proxy GETs to execute; explicit value
  overrides the parent and omission inherits. `HEAD` and explicit prefetch remain non-executing.
- `note?: string` — child-specific author note, implies an interstitial. Notes do not inherit,
  and `note` cannot combine with `interstitial: false`.
- `browser?: SmartlinksBrowserPolicy` and `cors?: true` — the child's browser boundary, chosen
  independently rather than inherited. A child with nonempty `browser.embeddableBy` must
  explicitly set `interstitial: false`; `note` is then impossible.
- `seal?: Record<string, string>` — strings to encrypt for the child's `ctx.secrets`, each value
  at most 1,024 characters: direct parent secrets, derived values, or generated values.

One `ctx.compile` attempt per execution, including failed attempts. Tuple data is canonical JSON
with a 64 KB encoded limit, 32-level depth limit, 10,000-value limit, and no `__proto__` keys.
The runtime rejects any decrypted parent-secret bytes found in child source, packaged closures,
or tuple data — move intentional delegation through `seal`, where each value also consumes a
cryptographic operation. This exact-byte scan is an accidental-leak guardrail, not
information-flow analysis; transformed, encoded, or split secret values cannot be identified.

Self-continuing chains are supported, unbounded by design: a packaged closure may compile another
closure or itself — closure-table references are not outer captures — and each hop is an ordinary
execution that independently reapplies the same one-mint budget, validation, expiry resolution,
sealing, and payload limits. There is no built-in stored ancestry, generation counter, or depth policy.

A parent whose mint branch is reachable by anyone holding its URL is an unauthenticated admin
endpoint. Keep parent links private or verify a signed request before compiling. The verification
is built from what is already here: seal an HMAC key, deliver it to intended callers out-of-band,
and require `verifyHmacSha256` over the parameters plus a timestamp — freshness is a window
check, and replay inside the window is the client's job, as with tokens.

## CLI discovery

Smartlinks requires Node.js 24 or newer: `npm install --global @jonaslsa/smartlinks`, then treat
the installed help as authoritative (`smartlinks --help`, `help build`, `help run`,
`help decode`, `help whoami`). There is no `compile` or `dry-run` command: `build` performs the whole pipeline
without executing the script (QuickJS validation is compile-only); `run` is the local execution
and validation path. Execution URLs are bearer artifacts — read "Treat the generated link as a
compiled artifact" below before printing or copying one.

`SMARTLINKS_URL` overrides the runtime origin, including the host baked into built links. An
automatically selected author identity must belong to that origin. With no secrets and no identity
(or with `--no-sign`), nothing is fetched, so a wrong value silently emits links to a host that may
not exist.

## `smartlinks build <script.js|script.ts>`

- `--interstitial`: require browser confirmation — GET renders the confirmation page, a POST
  carrying `?__confirm=1` executes, and any other request receives HTTP 405. Unsuitable for
  multi-step flows: relative links and `<form method=get>` re-enter by GET, so every step
  reconfirms.
- `--interstitial-note TEXT`: add an author note (whitespace-normalized, 140 Unicode characters
  max) and require confirmation.
- `--allow-crawlers`: allow known crawler and image-proxy GETs to execute. Use only when the
  response itself is meant for them; all ordinary execution policies still apply.
- Repeat `--allow-script`, `--allow-connect`, `--allow-image`, `--allow-style`, `--allow-font`,
  `--allow-media`, `--allow-frame`, `--allow-form`, or `--allow-embed` with `self`, `https`,
  `all`, or an exact HTTPS origin. These set the matching browser-policy field. Inline script and
  style need no flag. `--allow-embed` cannot combine with an interstitial.
- `--referrer none|origin|full`: disclosure policy; omission is `none`. `full` sends the complete
  bearer Smartlink URL, including user query parameters, to eligible destinations; prefer
  `origin` unless that disclosure is intentional.
- `--cors`: make this artifact a credential-free cross-origin target and answer preflight without
  executing it. Callers still need `--allow-connect` for this origin.
- `--secret NAME[=value]`: seal a secret; repeatable. Prefer environment values over inline.
- `--expires VALUE`: a duration (`30m`, `1h`, `7d`) or absolute ISO 8601 date, stored as integer
  Unix seconds in UTC; past dates are rejected.
- `--copy`: copy the execution URL and print only a compact fingerprint and size receipt.
- `--out FILE`: write the URL to a file and print the fingerprint and size receipt; new and
  existing regular files are set to owner-only permissions on POSIX. `--out /dev/null` runs the
  whole pipeline and prints the receipt while keeping no artifact.
- `--json`: machine-readable output; without `--copy` or `--out` it includes the execution URL
  once, never a decoder URL.
- `--no-sign`: build unsigned even when a valid author identity is configured.
- `--no-type-check`, `--no-minify`: as above.

If a browser decoder URL is needed, replace the execution URL's first `/r/` path segment with
`/d/`.

### Treat the generated link as a compiled artifact

The execution URL is opaque and carries bearer authority. Do not repeat it to the user or copy it
into reasoning, plans, or other working context. Iterate with `run`, then finish with
`build --out link.txt` (keep the file out of version control) or `--copy` when the user should
receive the link directly; if clipboard access is unavailable, ask the user to run the final
command rather than printing the URL. The flags combine, and the clipboard is shared state the
CLI cannot re-check — prefer `--copy --out link.txt` so a clobbered clipboard can be re-verified
and refilled from the file instead of rebuilding. Both modes suppress the URL and report character count,
payload version, budget usage, a short fingerprint — the first 12 hex characters of SHA-256 over
the full execution URL — and any expiry as an absolute UTC timestamp. Compare the fingerprint
when checking an opaque clipboard or file artifact; `smartlinks decode - < link.txt` does this
without putting the bearer URL in command arguments. It is not an authenticity guarantee.

## `smartlinks run <script.js|script.ts>`

The local dry-run before building a final link.

- `--param NAME=value`, `--secret NAME[=value]`, `--header NAME=value`: repeatable request
  inputs.
- `--method METHOD` (defaults to `GET`); `--body TEXT` (invalid for `GET` and `HEAD`).
- `--allow-network`: enable guarded `fetch`; networking is disabled by default locally.
- `--simulate`: run one deterministic path with no network requests; see below. Cannot combine
  with `--allow-network` or `--serve`.
- `--simulate-response STATUS`: imply simulation and set the next allowed fetch's status;
  repeatable. Redirect statuses are unsupported.
- `--json`: machine-readable mapped response, or the simulation report with `--simulate`.
- The same `--allow-*`, `--referrer`, and `--cors` browser-policy flags as `build`; `run --serve`
  applies them to real browser responses on the loopback server.
- `--no-type-check`, `--no-minify`: as above.

`run --serve` prints a private per-session entry URL on `127.0.0.1:8787` (`--port` overrides; `0`
picks a free port), re-reads and checks the source for every entry request, and uses the real
browser query parameters, method, headers, and body. The unguessable entry path prevents arbitrary
websites from triggering the local root script by probing the port. Local `ctx.compile` returns a clickable URL on the same
loopback origin; that route executes the immutable child with the real browser request, and
children may mint further clickable children for the lifetime of the server session. The request
flags above and `--json` are intentionally unavailable. Local secrets, `--allow-network`,
`--no-type-check`, and `--no-minify` still apply. Serve mode never builds a production link,
fetches the runtime key, or contacts production.

`--simulate` traces fetches, blocked fetches, and successful child mints without sending anything:
every allowed fetch receives HTTP 200, `content-type: application/json`, and `{}` by default.
Configured statuses are consumed by allowed fetches in order, then fall back to that default.
204, 205, and 304 remain bodyless. Runtime-host,
URL, method, header, body, redirect, response-size, and five-request guards still apply; no DNS
lookup occurs. With `--json` the report is stable: normalized input, chronological events, and
the final mapped response or error. A mint is recorded whether its URL is returned, embedded, or
discarded; the trace follows a locally compiled child only when execution returns its URL, without
printing the URL in the compile event. Simulation is for trusted-source authoring, not for deciding
whether an unknown Smartlink is safe — it covers one control-flow path. Exact supplied secret values are
replaced with `[secret:NAME]` in recorded URLs, headers, bodies, responses, and errors, including
common URL and JSON encodings; derived or transformed values cannot be recognized, so treat the
report as potentially sensitive. Binary final responses include `bodyBytes` and `bodyBase64`; a
Base64 body containing an exact secret becomes `bodyRedacted`.

Local execution uses the same wrapper, QuickJS engine, request-context normalization, fetch
policy, response mapping, and compile validation as production. Local `ctx.compile` seals with an
ephemeral in-process keypair. One-shot `run` returns local-only
`https://smartlinks.local/r/<payload>` URLs and follows them in the same process. In serve mode the
keypair is stable for the server session and compilation uses the active loopback origin, so links
embedded in HTML or other responses can be opened later; a child receives only the secrets
deliberately sealed into its payload, never the root command's undelegated secrets. One-shot `run`
follows directly returned compiled links with a ten-hop limit; serve mode returns the mapped 302
so the browser navigates to the child artifact, matching production routing. Local execution never
contacts `/pk`, uses production key material, or publishes a durable bearer link. For binary
responses, `--json` emits `bodyBase64`; redirected plain stdout receives the exact bytes; an
interactive terminal prints a byte-count receipt instead of binary data.

## `smartlinks decode <link-or-payload|-> [--json]`

Inspects the emitted script and metadata without executing or decrypting secrets. Renders
`notAfter` as an absolute UTC timestamp and marks expired links; displays any author note and the
same payload facts shown by the browser interstitial. `decode` is entirely local: it works offline
and on expired links, so neither expiry nor rate limits affect what a reader learns from a payload.
Pass `-` to read stdin. Full URL inputs report the canonical execution fingerprint; decoder routes
are normalized to `/r/`, and query parameters and fragments are excluded. Bare payloads omit it.

## Author signing

`smartlinks login` runs a zero-permission GitHub App device flow, generates a local author key, and
stores only that private key and its 90-day Smartlinks certificate. The temporary GitHub token is
discarded during issuance. Run `whoami` as a preflight before a build that must sign, before
composing a command that carries secrets — a stale identity fails the build itself.
`smartlinks whoami [--json]` verifies the certificate and local signing
key without building; it exits nonzero when the identity is missing, expired, or invalid.
`smartlinks logout` removes the local author identity. The credential is scoped to the runtime that
issued it. Builds for that runtime sign automatically; builds without an identity stay unsigned.
An expired, invalid, or wrong-runtime identity fails rather than silently producing an unsigned
artifact. Use `--no-sign` to deliberately bypass the stored identity.

Signing is provenance, not endorsement or additional authority. The Worker rejects invalid signed
artifacts before execution, while unsigned links remain valid. An expired certificate leaves the
artifact signature intact but reports `author certificate expired`; without a transparency log,
the runtime cannot trust a signing timestamp supplied by the author. Compiled children are separate
artifacts and remain unsigned. `decode` verifies locally and never contacts GitHub.

## Secrets and authority

The CLI fetches the runtime's public key and encrypts each requested secret locally. Ciphertext
is bound to the active key ID, the target secret name, and the complete immutable
authority-bearing artifact: entry script, ordered compile table, baked program data, expiry,
execution-policy flags, and any author note. Changing any of those makes decryption fail; dynamic
request parameters remain variable input and are not part of the binding. The private key remains
a Worker secret.

Author notes are public, attributed text — not verified identity. Anyone can recover them with
`decode`; never put credentials or private data in a note.

Encryption hides values from URL inspection; it does not make the execution URL private. Anyone with the complete URL can invoke the script with its sealed authority until `notAfter`, when present. Prefer narrowly scoped, revocable credentials, but a script that reads no request input into its outbound calls and returns nothing derived from a secret is a closed capability: the link grants exactly the operation the author wrote.
Avoid inline `NAME=value` secrets because shell history retains them; if there is a frontend, do not leak secrets to the client. 

Sealing is the only way to keep a value out of the decoded artifact, but the running script stays
an oracle: anything its output is a function of can be recovered by exercising the link. Seal what
the script never reflects back.

Expiry on a link with sealed secrets is enforced by that binding; without them it is advisory —
the Worker still returns HTTP 410 after the deadline, but anyone can decode the public source and
build a separate link without it.

Expiry is the zero-infrastructure kill switch; gating execution on an author-controlled endpoint
is the immediate one — take it down and every link checking it dies, real revocation with no
service-side registry. It costs one of the five fetches and its latency per execution, couples
availability to that endpoint, and the author's check decides whether an unreachable endpoint
fails open or closed.

## Runtime and link limits

- Execution links are immutable, with no authentication, revocation list, or per-link analytics.
  `notAfter` is checked before sandbox execution; normal expired executions return HTTP 410. A
  script that throws, exhausts a budget, or returns an invalid response shape yields HTTP 422.
  The hosted runtime may rate-limit executions; excess executions return HTTP 429 with a
  `retry-after` header to honor before retrying.
- Encoded payloads are limited to 7,800 characters; raw and emitted source have a
  one-million-character wrong-file guard.
- Each request gets a fresh QuickJS runtime: 16 MiB heap, 512 KiB stack, deterministic
  1,500-interrupt-poll budget, and a 15-second host-wait deadline. The platform separately
  enforces about 10 milliseconds of CPU time per execution — cycles, not wall clock, effectively
  unmeasurable from inside — which is why the poll budget is a deterministic proxy rather than a
  CPU-time measurement.
- `fetch` permits HTTP(S); blocks Smartlinks runtime hostnames, local hostnames, and
  private/local/reserved IP literals; limits same-origin redirects to three, total requests to
  five, request and response bodies to 1 MiB, and each fetch to ten seconds. Cross-origin
  redirects are rejected. A Smartlink cannot invoke the runtime by HTTP; use `ctx.compile` to
  create a child link. Local `run --allow-network` additionally resolves and pins DNS connections
  to validated public addresses.
- Known crawler, preview, prefetch, and `HEAD` requests do not execute scripts by default; they
  receive a non-executing HTTP 200 preview with `x-smartlinks-preview: 1`, even after expiry.
  `--allow-crawlers` lets known crawler and image-proxy GETs execute; `HEAD` and explicit prefetch
  remain non-executing. Its presence confirms that guest code did not run only on the immediate
  response from the configured Smartlinks runtime: disable redirect following and verify the
  response origin before trusting it.
  Absence alone does not prove execution. Detection is intentionally best-effort.
- Authored browser responses are always opaque-origin CSP sandboxes. Browser capability fields
  may open external resources, connections, form targets, embedding, or referrer disclosure, but
  cannot enable `allow-same-origin`, cookies, persistent storage, or service workers. CORS is
  wildcard and credential-free. No browser capability requires an interstitial; embedding and an
  interstitial are instead mechanically incompatible.
- Browser and intermediary URL limits vary; shorter links are preferable even below the hard cap.

## Budgeting the payload

The 7,800-character limit applies to the compressed payload, so the practical ceiling depends on
what a script contains, not how long it is. Minification renames locals and strips formatting;
compression collapses repetition; neither shrinks unique string data.

| Script content                                   | Source that still fits | Ratio      |
| ------------------------------------------------ | ---------------------- | ---------- |
| Logic: functions, branches, local names          | ~75,000 characters     | 6x to 10x  |
| Markup: inline HTML and CSS in template literals | ~45,000 characters     | 3x to 6x   |
| Unique string data: word lists, tables, literals | ~11,000 characters     | about 1.4x |

Ratios improve as scripts grow — the same markup shape measures 2.8x at 1,900 source characters
and 5.8x at 27,000 — so small scripts understate the headroom. A full HTML page with inline CSS,
escaping, and a fetch call lands near 2,500. Write readable code rather than golfing it, keep
bulk data out of the payload, and read the printed budget instead of estimating. Each `--secret`
adds about 110 characters of encrypted envelope, near enough independent of the value's length.

Keep scripts explicit and least-privileged; size is a payload question, not a design constraint.
Inspect with `decode` before finalizing, and smoke-test the immutable link if that is safe.
