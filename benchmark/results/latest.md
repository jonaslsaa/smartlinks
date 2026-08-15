# Latest URL codec benchmark

Generated 2026-08-14T23:22:46.929Z on v26.5.0 (darwin/arm64).

Sizes are the sum across the pinned seven-file Cloudflare corpus. Timings are single-run local measurements and are directional only.

## Corpus

| Sample | Raw bytes |
| --- | ---: |
| tiny-formatters | 457 |
| small-api | 1,312 |
| small-service | 3,373 |
| medium-chat | 6,049 |
| medium-renderer | 14,500 |
| large-setup | 22,467 |
| oversize-interface | 74,980 |

## Minification

Every minifier is followed by the current fflate deflate-raw level 9 and base64url pipeline.

| Minifier | JS bytes | Payload chars | vs current Terser | Total ms |
| --- | ---: | ---: | ---: | ---: |
| none | 123,138 | 42,250 | +63.44% | 0.04 |
| terser-current-safe | 69,580 | 25,851 | +0.00% | 122.12 |
| terser-aggressive | 69,569 | 25,844 | -0.03% | 129.60 |
| esbuild | 71,122 | 26,699 | +3.28% | 17.54 |
| swc | 68,837 | 25,714 | -0.53% | 10.44 |

## Compression

Compression uses the current safe Terser output and base64url. `extra-decoder` methods are not natively decodable by Cloudflare Compression Streams.

| Compressor | Runtime fit | Bytes | Payload chars | vs current fflate | Compress/decompress ms |
| --- | --- | ---: | ---: | ---: | ---: |
| none | none | 71,993 | 96,000 | +271.36% | 0.03/0.02 |
| fflate-deflate-raw-9 | current | 19,381 | 25,851 | +0.00% | 1.04/0.78 |
| fflate-deflate-raw-9-dictionary | current | 19,018 | 25,367 | -1.87% | 1.02/0.54 |
| native-deflate-raw-9 | worker-native | 18,860 | 25,157 | -2.68% | 1.52/0.24 |
| native-gzip-9 | worker-native | 18,986 | 25,325 | -2.03% | 1.07/0.21 |
| brotli-q4 | extra-decoder | 19,158 | 25,554 | -1.15% | 1.21/0.29 |
| brotli-q9 | extra-decoder | 17,662 | 23,558 | -8.87% | 2.74/0.22 |
| brotli-q11 | extra-decoder | 16,323 | 21,773 | -15.78% | 49.40/0.30 |
| zstd-default | extra-decoder | 20,297 | 27,072 | +4.72% | 0.43/0.20 |

## URL encoding

Encoding uses the current safe Terser plus fflate output. Browser-path characters use component escaping, which guarantees one reversible path segment. `Direct` means the raw alphabet also survives WHATWG URL parsing without becoming a query, fragment, or extra path segment.

| Encoder | Base | Safety tier | Raw chars | Browser-path chars | vs base64url | Direct | Encode/decode ms |
| --- | ---: | --- | ---: | ---: | ---: | :---: | ---: |
| hex | 16 | unreserved | 38,769 | 38,769 | +49.97% | yes | 278.92/185.38 |
| base64url | 64 | unreserved | 25,851 | 25,851 | +0.00% | yes | 0.21/0.86 |
| base66-unreserved | 66 | unreserved | 25,661 | 25,661 | -0.73% | yes | 227.42/123.82 |
| base71-component | 71 | component | 25,222 | 25,222 | -2.43% | yes | 509.95/118.99 |
| base79-path | 79 | path | 24,606 | 29,662 | +14.74% | yes | 501.93/116.17 |
| base85-z85-alphabet | 85 | escaped | 24,201 | 33,759 | +30.59% | no | 215.04/113.92 |
| base91 | 91 | escaped | 23,835 | 35,637 | +37.86% | no | 214.01/110.06 |

## Full end-to-end combinations

This is the complete matrix of plausible schema candidates after pruning the individually dominated no-minification, no-compression, hex, base85, and base91 diagnostics. Every total includes one schema character, the JSON envelope, and all seven corpus files. A separate version plus schema character would add one character per link without changing the ranking.

### Shortest component-safe combinations

| Minifier | Compressor | Encoder | Payload chars | vs current |
| --- | --- | --- | ---: | ---: |
| swc | brotli-q11 | base71-component | 21,100 | -18.38% |
| terser-current-safe | brotli-q11 | base71-component | 21,241 | -17.83% |
| terser-aggressive | brotli-q11 | base71-component | 21,247 | -17.81% |
| swc | brotli-q11 | base66-unreserved | 21,468 | -16.95% |
| terser-current-safe | brotli-q11 | base66-unreserved | 21,612 | -16.40% |
| terser-aggressive | brotli-q11 | base66-unreserved | 21,617 | -16.38% |
| swc | brotli-q11 | base64url | 21,628 | -16.34% |
| terser-current-safe | brotli-q11 | base64url | 21,773 | -15.78% |

### Shortest raw browser-path combinations

These values are valid as one direct WHATWG browser path segment but may contain punctuation that is fragile in other link-sharing contexts.

| Minifier | Compressor | Encoder | Payload chars | vs current |
| --- | --- | --- | ---: | ---: |
| swc | brotli-q11 | base79-path | 20,585 | -20.37% |
| terser-current-safe | brotli-q11 | base79-path | 20,721 | -19.84% |
| terser-aggressive | brotli-q11 | base79-path | 20,727 | -19.82% |
| swc | brotli-q11 | base71-component | 21,100 | -18.38% |
| terser-current-safe | brotli-q11 | base71-component | 21,241 | -17.83% |
| terser-aggressive | brotli-q11 | base71-component | 21,247 | -17.81% |
| esbuild | brotli-q11 | base79-path | 21,337 | -17.46% |
| swc | brotli-q11 | base66-unreserved | 21,468 | -16.95% |
