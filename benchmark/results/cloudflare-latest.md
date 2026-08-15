# Cloudflare end-to-end CPU benchmark

Measured on 2026-08-15 from Oslo against a temporary `workers.dev` deployment of the real Worker
bundle. Cloudflare reported a 31 ms Worker startup time and a 528.76 KiB compressed upload. The
temporary Worker used the account's standard usage model, 100% invocation-log sampling, and the
Free plan's fixed 10 ms CPU allowance.

Each row contains 30 measured requests after 5 warmups. CPU values come from Cloudflare's live-tail
invocation events; client wall time is intentionally excluded because it includes network latency.

## Current payload path

Two runs are shown because a secret change created a fresh Worker version between them. The
substantial variation is itself relevant: results must leave room for isolate/runtime startup and
JIT variability rather than relying only on a warmed median.

| Payload | Route | CPU p50 run 1 | CPU p95 run 1 | CPU max run 1 | >10 ms run 1 | CPU p50 run 2 | CPU p95 run 2 | CPU max run 2 | >10 ms run 2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 47 chars | decode `/d` | 0 ms | 1 ms | 1 ms | 0/30 | 1 ms | 8 ms | 11 ms | 1/30 |
| 47 chars | execute `/r` | 1 ms | 3 ms | 4 ms | 0/30 | 2 ms | 25 ms | 26 ms | 7/30 |
| 3,900 chars | decode `/d` | 3 ms | 18 ms | 34 ms | 4/30 | 11 ms | 19 ms | 21 ms | 15/30 |
| 3,900 chars | execute `/r` | 4 ms | 16 ms | 17 ms | 4/30 | 10 ms | 33 ms | 38 ms | 14/30 |
| 7,749 chars | decode `/d` | 6 ms | 19 ms | 22 ms | 8/30 | 20 ms | 32 ms | 32 ms | 23/30 |
| 7,749 chars | execute `/r` | 8 ms | 22 ms | 23 ms | 8/30 | 13 ms | 31 ms | 32 ms | 22/30 |

Every request in both runs returned HTTP 200 with Cloudflare outcome `ok`, including requests above
10 ms. This is consistent with Cloudflare's documented occasional flexibility: a Free-plan Worker
can exceed 10 ms sometimes, but code that does so consistently can be terminated with error 1102.
The near-limit path therefore worked during this sample but does not have a safe Free-plan CPU
margin.

## Current per-secret HPKE path

These cases execute a tiny script and independently decrypt 1, 4, or 8 sealed 32-character values.
They were measured on the fresh version from run 2.

| Sealed values | Payload | CPU p50 | CPU p95 | CPU max | >10 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 232 chars | 6 ms | 29 ms | 34 ms | 9/30 |
| 4 | 592 chars | 6 ms | 24 ms | 26 ms | 10/30 |
| 8 | 1,055 chars | 6 ms | 22 ms | 26 ms | 4/30 |

The sample does not demonstrate a meaningful CPU increase from 1 to 8 secrets; the WebCrypto
operations run concurrently and runtime variance is larger than any observed difference. Bundling
the secret map into one HPKE ciphertext remains compelling for URL length, but CPU savings should
not be claimed from this sample.

## Measurement boundary

The `cpuTime` field is Cloudflare's own invocation-level CPU accounting, reported as integer
milliseconds. It measures active execution of the Worker rather than client/network wall time, and
it is the relevant signal for the platform's CPU allowance. It is not a hardware cycle counter and
cannot attribute time to individual functions.

The results are suitable for detecting that an end-to-end path frequently has insufficient margin
against 10 ms, but not for ranking two implementations separated by a few milliseconds:

- integer-millisecond reporting is coarse for tiny requests;
- five warmups do not guarantee that later requests reach the same isolate;
- cases were executed in a fixed grouped order, so isolate startup, JIT state, and platform drift
  are not evenly distributed between cases;
- 30 observations per row are enough to expose large overruns but not to characterize rare-tail
  reliability;
- the half-limit and near-limit inputs contain deterministic low-compressibility string literals;
  they stress valid payload sizes but do not represent the distribution of real user scripts;
- these remote runs exercise only the current Terser, fflate raw-DEFLATE, and base64url schema. The
  alternative codec size matrix was measured locally; alternate decoders were not deployed or
  compared remotely.

A stricter follow-up should interleave cases in randomized rounds, repeat across fresh deployments,
and use a local workerd CPU profile to attribute cost by stage. Cloudflare deliberately freezes
high-resolution timers during CPU-only execution, so adding `performance.now()` around decoder
functions in the deployed Worker would not produce valid stage timings.

## Interpretation

- Tiny links usually fit the Free CPU allowance comfortably, although fresh-version tail data had
  occasional startup/runtime spikes.
- Medium and near-limit links do not reliably fit 10 ms with the current fflate decoder, schema
  validation, rendering, and QuickJS path.
- This strengthens the conservative codec recommendation: raw DEFLATE plus base64url. A Brotli
  schema requiring a JavaScript or WASM decoder should not be added to this hot path without a
  workerd/Cloudflare CPU benchmark.
- A native `DecompressionStream("deflate-raw")` decoder is the most promising next performance
  experiment because Cloudflare supports it without adding a decoder dependency. It still needs a
  streaming decompressed-size guard and an end-to-end remote comparison before adoption.

The temporary Worker and its private test key were deleted after measurement.
