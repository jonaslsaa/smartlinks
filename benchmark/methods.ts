import * as zlib from "node:zlib";
import { minify as swcMinify } from "@swc/core";
import baseX from "base-x";
import { transform } from "esbuild";
import { deflateSync as fflateDeflate, inflateSync as fflateInflate } from "fflate";
import { minify as terserMinify } from "terser";
import { fromBase64Url, toBase64Url } from "../src/shared/bytes.js";

export type Minifier = {
  id: string;
  minify(source: string): Promise<string>;
};

export type Compressor = {
  id: string;
  runtime: "current" | "worker-native" | "extra-decoder" | "none";
  compress(bytes: Uint8Array): Uint8Array;
  decompress(bytes: Uint8Array): Uint8Array;
};

export type Encoder = {
  id: string;
  alphabetSize: number;
  safety: "unreserved" | "component" | "path" | "escaped";
  encode(bytes: Uint8Array): string;
  decode(value: string): Uint8Array;
};

function requireCode(id: string, code: string | undefined): string {
  if (!code) {
    throw new Error(`${id} did not produce output.`);
  }
  return code.trim();
}

export const MINIFIERS: readonly Minifier[] = [
  {
    id: "none",
    minify: async (source) => source,
  },
  {
    id: "terser-current-safe",
    minify: async (source) =>
      requireCode(
        "terser-current-safe",
        (
          await terserMinify(source, {
            module: true,
            compress: { passes: 2, side_effects: false },
            mangle: true,
            ecma: 2022,
            format: { comments: false, semicolons: true },
          })
        ).code,
      ),
  },
  {
    id: "terser-aggressive",
    minify: async (source) =>
      requireCode(
        "terser-aggressive",
        (
          await terserMinify(source, {
            module: true,
            compress: { passes: 3 },
            mangle: true,
            ecma: 2022,
            format: { comments: false, semicolons: true },
          })
        ).code,
      ),
  },
  {
    id: "esbuild",
    minify: async (source) =>
      (
        await transform(source, {
          loader: "js",
          format: "esm",
          minify: true,
          target: "es2022",
        })
      ).code.trim(),
  },
  {
    id: "swc",
    minify: async (source) =>
      requireCode(
        "swc",
        (
          await swcMinify(source, {
            module: true,
            compress: { passes: 2, side_effects: false },
            mangle: true,
            ecma: 2022,
          })
        ).code,
      ),
  },
] as const;

const identityCompressor: Compressor = {
  id: "none",
  runtime: "none",
  compress: (bytes) => bytes.slice(),
  decompress: (bytes) => bytes.slice(),
};

// A deliberately small, hand-written dictionary of syntax and APIs likely to appear in
// Smartlinks. It is shared out-of-band by a payload version, so its bytes do not enter the URL.
const SMARTLINKS_DICTIONARY = new TextEncoder().encode(`
async function return const let var if else for while try catch finally throw await new typeof
true false null undefined string number object length map filter reduce entries values keys
ctx.params ctx.method ctx.headers ctx.body ctx.secrets ctx.fetch
request response status headers body url method signal redirect
JSON.stringify JSON.parse Object.entries Object.fromEntries Object.keys Object.values
Array.isArray Promise.all encodeURIComponent decodeURIComponent URL URLSearchParams
"Content-Type" "application/json" "Authorization" "Bearer "
https:// api.github.com fetch(
`);

export const COMPRESSORS: Compressor[] = [
  identityCompressor,
  {
    id: "fflate-deflate-raw-9",
    runtime: "current",
    compress: (bytes) => fflateDeflate(bytes, { level: 9 }),
    decompress: fflateInflate,
  },
  {
    id: "fflate-deflate-raw-9-dictionary",
    runtime: "current",
    compress: (bytes) => fflateDeflate(bytes, { level: 9, dictionary: SMARTLINKS_DICTIONARY }),
    decompress: (bytes) => fflateInflate(bytes, { dictionary: SMARTLINKS_DICTIONARY }),
  },
  {
    id: "native-deflate-raw-9",
    runtime: "worker-native",
    compress: (bytes) => zlib.deflateRawSync(bytes, { level: 9 }),
    decompress: zlib.inflateRawSync,
  },
  {
    id: "native-gzip-9",
    runtime: "worker-native",
    compress: (bytes) => zlib.gzipSync(bytes, { level: 9 }),
    decompress: zlib.gunzipSync,
  },
  {
    id: "brotli-q4",
    runtime: "extra-decoder",
    compress: (bytes) =>
      zlib.brotliCompressSync(bytes, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
    decompress: zlib.brotliDecompressSync,
  },
  {
    id: "brotli-q9",
    runtime: "extra-decoder",
    compress: (bytes) =>
      zlib.brotliCompressSync(bytes, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
      }),
    decompress: zlib.brotliDecompressSync,
  },
  {
    id: "brotli-q11",
    runtime: "extra-decoder",
    compress: (bytes) =>
      zlib.brotliCompressSync(bytes, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    decompress: zlib.brotliDecompressSync,
  },
];

const zstdCompressValue = Reflect.get(zlib, "zstdCompressSync");
const zstdDecompressValue = Reflect.get(zlib, "zstdDecompressSync");
if (typeof zstdCompressValue === "function" && typeof zstdDecompressValue === "function") {
  const zstdCompress = zstdCompressValue as (bytes: Uint8Array) => Uint8Array;
  const zstdDecompress = zstdDecompressValue as (bytes: Uint8Array) => Uint8Array;
  COMPRESSORS.push({
    id: "zstd-default",
    runtime: "extra-decoder",
    compress: zstdCompress,
    decompress: zstdDecompress,
  });
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE66_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._~";
const BASE71_ALPHABET = `${BASE66_ALPHABET}!*'()`;
const BASE79_ALPHABET = `${BASE71_ALPHABET}$&+,;=:@`;
const Z85_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
const BASE91_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';

function radixEncoder(id: string, alphabet: string, safety: Encoder["safety"]): Encoder {
  const codec = baseX(alphabet);
  return {
    id,
    alphabetSize: alphabet.length,
    safety,
    encode: codec.encode,
    decode: codec.decode,
  };
}

export const ENCODERS: readonly Encoder[] = [
  radixEncoder("hex", "0123456789abcdef", "unreserved"),
  {
    id: "base64url",
    alphabetSize: BASE64URL_ALPHABET.length,
    safety: "unreserved",
    encode: toBase64Url,
    decode: fromBase64Url,
  },
  radixEncoder("base66-unreserved", BASE66_ALPHABET, "unreserved"),
  radixEncoder("base71-component", BASE71_ALPHABET, "component"),
  radixEncoder("base79-path", BASE79_ALPHABET, "path"),
  radixEncoder("base85-z85-alphabet", Z85_ALPHABET, "escaped"),
  radixEncoder("base91", BASE91_ALPHABET, "escaped"),
] as const;

export type UrlInspection = {
  directPathSafe: boolean;
  directLength: number | null;
  escapedLength: number;
};

export function inspectUrlEncoding(value: string): UrlInspection {
  const direct = new URL(`https://smartlinks.example/r/${value}`);
  const expectedPath = `/r/${value}`;
  const directPathSafe =
    !value.includes("/") &&
    !value.includes("\\") &&
    direct.pathname === expectedPath &&
    direct.search === "" &&
    direct.hash === "";
  const escaped = new URL(`https://smartlinks.example/r/${encodeURIComponent(value)}`);

  if (decodeURIComponent(escaped.pathname.slice(3)) !== value) {
    throw new Error("The component-escaped URL did not round-trip.");
  }

  return {
    directPathSafe,
    directLength: directPathSafe ? value.length : null,
    escapedLength: escaped.pathname.length - 3,
  };
}
