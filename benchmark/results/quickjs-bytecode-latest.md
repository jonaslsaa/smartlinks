# QuickJS bytecode size benchmark

QuickJS commit: `f1139494d18a2053630c5ed3384a42bb70db3c53` (the exact revision named by the bundled `@jitl/quickjs-wasmfile-release-sync@0.32.0` package).
Compiler: `/tmp/smartlinks-quickjs-f1139494/smartlinks-bytecode-compiler`, using `COMPILE_ONLY`, `JS_STRIP_DEBUG`, and `JS_WriteObject`; the source filename is always `smartlink.js`.

The source baseline is: safe Terser -> JSON `{ s }` envelope -> raw DEFLATE level 9 -> base64url. The bytecode variants omit the JSON envelope and are therefore optimistic lower bounds for a real schema that also carries flags and sealed secrets. Every payload count includes one schema/version character.
Top-level imports and re-exports are removed before measuring both variants because the pinned corpus intentionally lacks its dependency tree. Five samples have no imports; this only normalizes the two dependency-bearing modules and does not make the corpus executable as Smartlinks.
Compile time is the median of five native compiler subprocess wall-time runs. It includes process startup, serialization, a verification deserialization, and writing the output; it is not CPU-cycle data or a browser-Wasm measurement.

| Sample | Original | Minified | Bytecode | Current source URL | Raw bytecode URL | Deflated bytecode URL | Deflated delta | compile |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tiny-formatters | 457 B | 195 B | 297 B | 212 | 397 | 340 | +60.38% | 3.68 ms |
| small-api | 1,312 B | 575 B | 786 B | 455 | 1,049 | 720 | +58.24% | 3.34 ms |
| small-service | 3,373 B | 2,270 B | 2,398 B | 833 | 3,199 | 1,315 | +57.86% | 3.00 ms |
| medium-chat | 6,049 B | 2,662 B | 3,256 B | 1,723 | 4,343 | 2,743 | +59.20% | 3.01 ms |
| medium-renderer | 14,500 B | 6,157 B | 6,631 B | 2,921 | 8,843 | 4,356 | +49.13% | 3.23 ms |
| large-setup | 22,467 B | 15,700 B | 17,331 B | 6,251 | 23,109 | 9,635 | +54.14% | 3.99 ms |
| oversize-interface | 74,980 B | 41,651 B | 37,671 B | 13,241 | 50,229 | 18,760 | +41.68% | 5.39 ms |
| **Total** | **123,138 B** | **69,210 B** | **68,370 B** | **25,636** | **91,169** | **37,869** | **+47.72%** | **25.64 ms** |

Raw QuickJS bytecode is version-specific and cannot currently be serialized or loaded through quickjs-emscripten's public API. Using it in Smartlinks would require maintaining a native FFI addition and treating a QuickJS upgrade as a payload-schema migration.
