# QuickJS engine spike

Measured on 2026-08-15 against temporary Workers in the same Cloudflare account as the
Smartlinks runtime. Both Workers used `quickjs-emscripten-core` 0.32.0, the release/sync
variant, a precompiled WASM module binding, a fresh 16 MB runtime per request, a 512 KB stack,
and the same 1,500-call deterministic interrupt budget. Both temporary Workers were deleted
after the comparison.

| Measurement | Original QuickJS | QuickJS-NG |
| --- | ---: | ---: |
| Bundle upload | 587.45 KiB | 612.58 KiB |
| Bundle gzip | 247.82 KiB | 263.89 KiB |
| Reported Worker startup | 8 ms | 9 ms |
| Deployed execution | Passed | Failed during WASM loading |

Original QuickJS passed the deployed simple-expression and transformation cases. An infinite
loop was interrupted on call 1,501 with `InternalError: interrupted`, and a 32 MB allocation
was rejected by the 16 MB heap limit with `InternalError: out of memory`. Its warm external
latency over 30 requests was 20.7 ms p50 / 101.7 ms p95 for the simple case and 12.2 ms p50 /
65.6 ms p95 for the transformation case. A burst of 25 concurrent simple requests completed
successfully in 58.5 ms total from the test client. These are end-to-end client timings, not
CPU-time measurements. They cannot establish compliance with a particular Workers CPU
allowance: the 1,500 interrupt polls are deterministic but are not calibrated to CPU cycles or
milliseconds. Production CPU metrics from Cloudflare are the relevant evidence for that limit.

The QuickJS-NG package worked locally under Node, but the identical deployed Worker returned
Cloudflare error 1042 while its Emscripten loader attempted a same-zone fetch instead of using
the supplied compiled-WASM module. Because it did not reach guest execution, no honest runtime
performance comparison is possible with the current package release. It was also 16.07 KiB
larger after gzip.

The production original-QuickJS Worker was separately verified live with a simple response, a
guarded GitHub API fetch, deterministic infinite-loop rejection, and heap-limit rejection. The
engine choice for v1 is therefore original QuickJS. QuickJS-NG can be reconsidered after its
Worker WASM-loading path is compatible, using the same spike rather than assuming local Node
behavior carries over to Workers.
