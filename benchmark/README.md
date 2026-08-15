# URL payload benchmark

This harness measures the URL characters produced by each stage of a Smartlinks payload:

1. minify JavaScript;
2. serialize the `{ "s": source }` envelope;
3. compress its UTF-8 bytes;
4. encode the compressed bytes as one URL path segment.

Run it with:

```sh
npm run benchmark:url
```

The QuickJS bytecode experiment uses the exact native QuickJS revision named by the bundled Wasm
package. Build its tiny compile/serialize/deserialize helper against that checkout, then run:

```sh
clang -O2 -I/path/to/quickjs benchmark/quickjs-bytecode-compiler.c \
  /path/to/quickjs/.obj/{quickjs,dtoa,libregexp,libunicode,cutils}.o \
  -lm -lpthread -ldl -o /path/to/quickjs/smartlinks-bytecode-compiler
QJS_BYTECODE_COMPILER=/path/to/quickjs/smartlinks-bytecode-compiler \
  npm run benchmark:quickjs-bytecode
```

The latest result is in [`results/quickjs-bytecode-latest.md`](results/quickjs-bytecode-latest.md).
Raw bytecode was much larger than minified source, and raw-DEFLATE-compressed bytecode produced
**47.72% more URL characters** across the corpus. The 22.5 KB `large-setup` sample grew from 6,251
to 9,635 characters, turning a fitting source payload into an over-limit bytecode payload. Keep
minified source; bytecode also adds QuickJS-version coupling and needs serializer/loader APIs that
quickjs-emscripten does not currently expose.

The separate Cloudflare harness deploys the real Worker with
[`cloudflare/wrangler.jsonc`](cloudflare/wrangler.jsonc), then exercises both the decode (`/d`) and
execute (`/r`) routes with tiny, half-limit, and near-limit valid payloads:

```sh
BENCHMARK_ORIGIN=https://temporary-worker.example.workers.dev npm run benchmark:cloudflare
```

The runner reports client-observed wall time and HTTP outcomes. Cloudflare invocation logs are the
source of truth for CPU time; local wall time includes network latency and response transfer.
`parse-tail.ts` consumes Wrangler's JSON tail output and summarizes measured (non-warmup) CPU time
by case and route.

The latest remote results are recorded in
[`results/cloudflare-latest.md`](results/cloudflare-latest.md). Near-limit requests frequently used
more than the Free plan's 10 ms CPU allowance even though Cloudflare's occasional flexibility let
every sampled request complete. Treat that as insufficient safety margin, not proof that the Free
limit is irrelevant.

## Payload capacity

The 7,800-character payload limit generally fits about **20–30 KB of readable application
JavaScript**, with highly compressible code reaching the separate 32,000-character source limit.
Low-compressibility literals or already-minified data can reduce practical capacity toward 7–8 KB.

Concrete current-pipeline examples from the pinned Cloudflare corpus:

| Cloudflare sample | Original JavaScript | Safe-Terser output | Current payload |
| --- | ---: | ---: | ---: |
| `llm-chat-app-template/public/chat.js` | 6,049 bytes / 230 lines | 2,662 bytes | 1,723 chars |
| `nlweb-template/public/json-renderer.js` | 14,500 bytes / 505 lines | 6,157 bytes | 2,921 chars |
| `workers-for-platforms-template/scripts/setup.js` | 22,467 bytes / 781 lines | 15,700 bytes | 6,251 chars |
| `nlweb-template/public/fp-chat-interface.js` | 74,980 bytes / 2,288 lines | 41,859 bytes | 13,360 chars |

The 22.5 KB setup script is the most useful example: it fits with 1,549 payload characters to spare.
At the same compression ratio, 7,800 payload characters would represent roughly 28 KB of original
source. The 75 KB interface demonstrates the other side: it is far over both the payload limit and
Smartlinks' 32 KB source limit.

These corpus files are compression inputs, not directly executable Smartlinks function bodies;
some depend on Node.js, browser DOM APIs, or module imports. Their sizes answer capacity, not runtime
compatibility. Sealed HPKE ciphertext is nearly incompressible and consumes the same budget: the
current per-secret representation added roughly 115–120 payload characters for each additional
32-character secret in the Cloudflare test.

The command downloads a pinned corpus on first use, verifies every file with SHA-256, tests every
compression and encoding round-trip, prints Markdown, and writes
[`results/latest.md`](results/latest.md) plus [`results/latest.json`](results/latest.json). The
download cache is ignored by Git.

## Recommendation

Keep **Terser's current safe configuration, raw DEFLATE, and base64url** as the default format.
Higher-base encodings do not buy enough to justify a custom codec or less shareable links.

The full candidate matrix confirms the trade-off:

- **Recommended now:** safe Terser + native raw DEFLATE level 9 + base64url. This is 2.68% shorter
  than the current implementation and remains the same decoding schema.
- **Recommended if a new decoder is justified:** safe Terser + Brotli quality 11 + base64url. This
  is 15.78% shorter while keeping the robust URL alphabet.
- **Absolute benchmark winner:** SWC + Brotli quality 11 + raw base79, at 20.37% shorter. This is not
  recommended because neither SWC semantic equivalence nor base79 link-sharing robustness has been
  established.

### Multiple schemas

The existing leading version character is already the right schema discriminator. For example,
`2` can forever mean raw-DEFLATE plus base64url and `3` can mean Brotli plus base64url. A second
schema character is unnecessary until format version and codec negotiation genuinely need to evolve
independently. If they do, one base64url character identifies up to 64 registered schemas.

Only choices required by decoding belong in that registry:

- Terser versus SWC does not need a schema ID; both produce JavaScript source.
- fflate versus native zlib does not need a schema ID; both produce interoperable raw-DEFLATE.
- Brotli versus DEFLATE does need a schema ID.
- A preset DEFLATE dictionary needs a distinct, immutable schema ID because the decoder needs the
  exact dictionary.
- A different URL alphabet needs a schema character outside the encoded data, since the decoder
  cannot decode an internal ID before it knows the alphabet.

It would be reasonable for the CLI to try every registered lossless compression schema and emit the
shortest result. On this corpus, however, Brotli quality 11 beat every other compressor for all seven
samples, so adaptive selection provided no demonstrated benefit over choosing Brotli directly. A
secret-heavy corpus containing incompressible HPKE blobs should be tested before claiming that is
universally true.

There is one small, compatible compression improvement worth considering separately: have the
Node CLI encode with native `zlib.deflateRawSync(..., { level: 9 })` while the Worker continues to
decode the standard raw-DEFLATE stream. It reduced this corpus's payload characters by **2.68%**,
and the tests prove native output can be decoded by the current fflate decoder. Doing that cleanly
would require separating the Node-only encoder from the Worker-safe decoder; it is not implemented
by this investigation.

The substantially smaller option is Brotli quality 11 at **15.78% fewer characters**. It is not a
good v1 choice: Cloudflare's native Compression Streams support deflate, deflate-raw, and gzip, but
not Brotli, so the Worker would need another JavaScript or WASM decoder. That adds bundle, startup,
and CPU risk precisely on the request path. Revisit Brotli as a new payload version only if real
scripts regularly hit the 7,800-character limit, and benchmark the chosen decoder inside workerd
before adopting it.

## What the results say

### Minification

The current safe Terser pipeline cut the aggregate final payload from 42,250 to 25,851 characters.
Aggressive Terser saved only another 0.03%. SWC was 0.53% smaller and much faster locally, but the
CLI's roughly 100 ms of authoring-time work is not important enough to trade away the already chosen
Terser semantics. The corpus scripts are minified as modules and are not executed, so this harness
does not claim semantic equivalence between minifiers.

### Compression

- fflate with a small shared JavaScript dictionary saved 1.87%, but couples every decoder to a
  versioned dictionary. Native zlib did better without that format-specific state.
- gzip remained 2.03% below current fflate because Node's native compressor is better here, but its
  framing is larger than native raw DEFLATE. There is no reason to choose gzip for this payload.
- Brotli quality 9 saved 8.87%; quality 11 saved 15.78%, at much higher authoring-time compression
  cost and with no native Worker decoder.
- Node's Zstandard default was 4.72% larger. Frame overhead and this workload make it a poor fit.

### URL encoding and browser characters

base64url uses only RFC 3986 unreserved characters and is extremely fast through built-in base64
primitives. The alternatives show why a higher theoretical radix is misleading:

- base66, still fully unreserved, saved only 0.73%;
- base71, using the extra characters left untouched by `encodeURIComponent`, saved 2.43% but adds
  punctuation that is awkward in shells, Markdown, and copied text;
- base79 was 4.82% shorter when inserted directly into a browser path. Once component-escaped for a
  reliably reversible, shareable path segment, it became 14.74% longer than base64url;
- base85 and base91 contain path, query, fragment, or percent-encoding characters. After escaping,
  they were 30.59% and 37.86% longer than base64url.

Tests verify that base64url, base66, base71, and base79 values survive WHATWG URL parsing as a single
raw path segment. They also verify a component-escaped round-trip for every alphabet. Browser-valid
is not the only constraint for this product, though: links are intended for GitHub comments, Slack,
HTML, terminals, and copy/paste. base64url is the robust choice.

## Corpus and reproducibility

The dataset is seven JavaScript files from Cloudflare's official
[`cloudflare/templates`](https://github.com/cloudflare/templates) repository, pinned to commit
[`7a0bc8f`](https://github.com/cloudflare/templates/tree/7a0bc8f9a10dc9233964bb8d834beff585d56f08).
It spans 457 bytes to 74,980 bytes and totals 123,138 bytes. The largest sample deliberately exceeds
Smartlinks' current source limit so the trend is visible beyond the accepted range.

These are representative JavaScript compression inputs, not Smartlinks function bodies. The
benchmark wraps each transformed source in the real short JSON envelope but does not include sealed
secrets, the service origin, or query parameters. Those add fixed or use-case-specific characters
without changing the relative encoding result.

Relevant platform constraints:

- [Cloudflare Compression Streams](https://developers.cloudflare.com/workers/runtime-apis/web-standards/#compression-streams)
  list deflate, deflate-raw, and gzip.
- The [WHATWG URL path percent-encode set](https://url.spec.whatwg.org/#path-percent-encode-set)
  explains which characters a browser preserves in a path and which become percent-encoded or act
  as delimiters.
- [Node's zlib documentation](https://nodejs.org/api/zlib.html) documents raw DEFLATE, Brotli, gzip,
  and the newer experimental Zstandard APIs used by the local comparison.

Sizes are deterministic for the pinned dependencies and corpus. Timings in `latest.md` are
single-run, machine-local measurements intended to catch order-of-magnitude costs, not to serve as
a microbenchmark.

Authoring latency is not a practical constraint here. On the largest sample still within the current
32 KB source limit (22.5 KB), safe Terser took about 24 ms, Brotli quality 11 took about 11 ms, and
generic base71 encoding took about 38 ms on the benchmark machine. Even the deliberately oversized
75 KB sample stayed below half a second for each individual stage. The full matrix takes longer only
because it evaluates 128 candidate pipelines.

Decoding has a different budget because it runs in the Worker for every request. On the 22.5 KB
sample, native base64url decoding took about 0.19 ms while the generic arbitrary-radix base71 decoder
took about 20 ms. A purpose-built block codec could improve that, but a 2.43% URL reduction does not
currently justify adding and validating one. Likewise, Node's native Brotli decode timing is not
evidence for a JavaScript or WASM Brotli decoder in workerd; that hot-path measurement remains the
gate for a Brotli schema.
