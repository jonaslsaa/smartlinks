import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus.js";
import {
  COMPRESSORS,
  type Compressor,
  ENCODERS,
  type Encoder,
  inspectUrlEncoding,
  MINIFIERS,
} from "./methods.js";

const OUTPUT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "results");
const utf8 = new TextEncoder();

type MinifierResult = {
  id: string;
  sourceBytes: number;
  envelopeBytes: number;
  baselinePayloadCharacters: number;
  milliseconds: number;
};

type CompressionResult = {
  id: string;
  runtime: Compressor["runtime"];
  compressedBytes: number;
  payloadCharacters: number;
  compressMilliseconds: number;
  decompressMilliseconds: number;
};

type EncodingResult = {
  id: string;
  alphabetSize: number;
  safety: Encoder["safety"];
  encodedCharacters: number;
  browserPathCharacters: number;
  directPathSafe: boolean;
  encodeMilliseconds: number;
  decodeMilliseconds: number;
};

type SampleResult = {
  id: string;
  rawBytes: number;
  minifiers: MinifierResult[];
  compressors: CompressionResult[];
  encoders: EncodingResult[];
};

type CombinationResult = {
  minifier: string;
  compressor: string;
  compressionRuntime: Compressor["runtime"];
  encoder: string;
  encodingSafety: Encoder["safety"];
  rawPayloadCharacters: number;
  componentPayloadCharacters: number;
  directPathSafe: boolean;
};

type BenchmarkReport = {
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    architecture: string;
  };
  pipeline: {
    compressionInput: string;
    compressionMinifier: string;
    encodingInput: string;
  };
  samples: SampleResult[];
  combinations: CombinationResult[];
};

function elapsed<T>(run: () => T): { value: T; milliseconds: number } {
  const started = performance.now();
  const value = run();
  return { value, milliseconds: performance.now() - started };
}

async function elapsedAsync<T>(run: () => Promise<T>): Promise<{
  value: T;
  milliseconds: number;
}> {
  const started = performance.now();
  const value = await run();
  return { value, milliseconds: performance.now() - started };
}

function envelopeBytes(source: string): Uint8Array {
  return utf8.encode(JSON.stringify({ s: source }));
}

function assertSameBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`${label} changed the byte length during its round-trip.`);
  }
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label} failed its round-trip at byte ${index}.`);
    }
  }
}

function requiredMethod<T extends { id: string }>(methods: readonly T[], id: string): T {
  const method = methods.find((candidate) => candidate.id === id);
  if (!method) {
    throw new Error(`Benchmark method ${id} is missing.`);
  }
  return method;
}

async function benchmark(): Promise<BenchmarkReport> {
  const corpus = await loadCorpus();
  const baselineCompressor = requiredMethod(COMPRESSORS, "fflate-deflate-raw-9");
  const baselineEncoder = requiredMethod(ENCODERS, "base64url");
  const compressionMinifier = requiredMethod(MINIFIERS, "terser-current-safe");
  const schemaMinifiers = MINIFIERS.filter((minifier) => minifier.id !== "none");
  const schemaCompressors = COMPRESSORS.filter((compressor) => compressor.id !== "none");
  const schemaEncoders = ENCODERS.filter(
    (encoder) => encoder.id !== "hex" && encoder.safety !== "escaped",
  );
  const samples: SampleResult[] = [];
  const combinationTotals = new Map<string, CombinationResult>();

  for (const sample of corpus) {
    const minifiedSources = new Map<string, string>();
    const minifiers: MinifierResult[] = [];

    for (const minifier of MINIFIERS) {
      const measured = await elapsedAsync(() => minifier.minify(sample.source));
      minifiedSources.set(minifier.id, measured.value);
      const input = envelopeBytes(measured.value);
      const compressed = baselineCompressor.compress(input);
      const encoded = baselineEncoder.encode(compressed);
      minifiers.push({
        id: minifier.id,
        sourceBytes: utf8.encode(measured.value).byteLength,
        envelopeBytes: input.byteLength,
        baselinePayloadCharacters: 1 + encoded.length,
        milliseconds: measured.milliseconds,
      });
    }

    const minifiedSource = minifiedSources.get(compressionMinifier.id);
    if (minifiedSource === undefined) {
      throw new Error(`No output was recorded for ${compressionMinifier.id}.`);
    }
    const input = envelopeBytes(minifiedSource);
    const compressedOutputs = new Map<string, Uint8Array>();
    const compressors: CompressionResult[] = [];

    for (const compressor of COMPRESSORS) {
      const compressed = elapsed(() => compressor.compress(input));
      const decompressed = elapsed(() => compressor.decompress(compressed.value));
      assertSameBytes(decompressed.value, input, compressor.id);
      compressedOutputs.set(compressor.id, compressed.value);
      compressors.push({
        id: compressor.id,
        runtime: compressor.runtime,
        compressedBytes: compressed.value.byteLength,
        payloadCharacters: 1 + baselineEncoder.encode(compressed.value).length,
        compressMilliseconds: compressed.milliseconds,
        decompressMilliseconds: decompressed.milliseconds,
      });
    }

    const encodingInput = compressedOutputs.get(baselineCompressor.id);
    if (!encodingInput) {
      throw new Error(`No output was recorded for ${baselineCompressor.id}.`);
    }
    const encoders: EncodingResult[] = [];

    for (const encoder of ENCODERS) {
      const encoded = elapsed(() => encoder.encode(encodingInput));
      const decoded = elapsed(() => encoder.decode(encoded.value));
      assertSameBytes(decoded.value, encodingInput, encoder.id);
      const url = inspectUrlEncoding(encoded.value);
      encoders.push({
        id: encoder.id,
        alphabetSize: encoder.alphabetSize,
        safety: encoder.safety,
        encodedCharacters: 1 + encoded.value.length,
        browserPathCharacters: 1 + url.escapedLength,
        directPathSafe: url.directPathSafe,
        encodeMilliseconds: encoded.milliseconds,
        decodeMilliseconds: decoded.milliseconds,
      });
    }

    for (const minifier of schemaMinifiers) {
      const source = minifiedSources.get(minifier.id);
      if (source === undefined) {
        throw new Error(`No output was recorded for ${minifier.id}.`);
      }
      const combinationInput = envelopeBytes(source);

      for (const compressor of schemaCompressors) {
        const compressed = compressor.compress(combinationInput);
        assertSameBytes(compressor.decompress(compressed), combinationInput, compressor.id);

        for (const encoder of schemaEncoders) {
          const encoded = encoder.encode(compressed);
          assertSameBytes(encoder.decode(encoded), compressed, encoder.id);
          const url = inspectUrlEncoding(encoded);
          const key = `${minifier.id}\u0000${compressor.id}\u0000${encoder.id}`;
          const previous = combinationTotals.get(key);
          combinationTotals.set(key, {
            minifier: minifier.id,
            compressor: compressor.id,
            compressionRuntime: compressor.runtime,
            encoder: encoder.id,
            encodingSafety: encoder.safety,
            rawPayloadCharacters: (previous?.rawPayloadCharacters ?? 0) + 1 + encoded.length,
            componentPayloadCharacters:
              (previous?.componentPayloadCharacters ?? 0) + 1 + url.escapedLength,
            directPathSafe: (previous?.directPathSafe ?? true) && url.directPathSafe,
          });
        }
      }
    }

    samples.push({
      id: sample.id,
      rawBytes: utf8.encode(sample.source).byteLength,
      minifiers,
      compressors,
      encoders,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    pipeline: {
      compressionInput: "UTF-8 JSON envelope containing terser-current-safe output",
      compressionMinifier: compressionMinifier.id,
      encodingInput: "fflate-deflate-raw-9 compressed envelope",
    },
    samples,
    combinations: [...combinationTotals.values()].sort(
      (left, right) => left.componentPayloadCharacters - right.componentPayloadCharacters,
    ),
  };
}

function sum(report: BenchmarkReport, select: (sample: SampleResult) => number): number {
  return report.samples.reduce((total, sample) => total + select(sample), 0);
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function percentChange(value: number, baseline: number): string {
  const change = ((value - baseline) / baseline) * 100;
  return `${change >= 0 ? "+" : ""}${fixed(change)}%`;
}

function markdown(report: BenchmarkReport): string {
  const lines: string[] = [
    "# Latest URL codec benchmark",
    "",
    `Generated ${report.generatedAt} on ${report.environment.node} (${report.environment.platform}/${report.environment.architecture}).`,
    "",
    "Sizes are the sum across the pinned seven-file Cloudflare corpus. Timings are single-run local measurements and are directional only.",
    "",
    "## Corpus",
    "",
    "| Sample | Raw bytes |",
    "| --- | ---: |",
  ];

  for (const sample of report.samples) {
    lines.push(`| ${sample.id} | ${sample.rawBytes.toLocaleString("en-US")} |`);
  }

  const baselineMinifierCharacters = sum(report, (sample) => {
    const result = requiredMethod(sample.minifiers, "terser-current-safe");
    return result.baselinePayloadCharacters;
  });
  lines.push(
    "",
    "## Minification",
    "",
    "Every minifier is followed by the current fflate deflate-raw level 9 and base64url pipeline.",
    "",
    "| Minifier | JS bytes | Payload chars | vs current Terser | Total ms |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const method of MINIFIERS) {
    const sourceBytes = sum(
      report,
      (sample) => requiredMethod(sample.minifiers, method.id).sourceBytes,
    );
    const characters = sum(
      report,
      (sample) => requiredMethod(sample.minifiers, method.id).baselinePayloadCharacters,
    );
    const milliseconds = sum(
      report,
      (sample) => requiredMethod(sample.minifiers, method.id).milliseconds,
    );
    lines.push(
      `| ${method.id} | ${sourceBytes.toLocaleString("en-US")} | ${characters.toLocaleString("en-US")} | ${percentChange(characters, baselineMinifierCharacters)} | ${fixed(milliseconds)} |`,
    );
  }

  const baselineCompressionCharacters = sum(report, (sample) => {
    const result = requiredMethod(sample.compressors, "fflate-deflate-raw-9");
    return result.payloadCharacters;
  });
  lines.push(
    "",
    "## Compression",
    "",
    "Compression uses the current safe Terser output and base64url. `extra-decoder` methods are not natively decodable by Cloudflare Compression Streams.",
    "",
    "| Compressor | Runtime fit | Bytes | Payload chars | vs current fflate | Compress/decompress ms |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const method of COMPRESSORS) {
    const compressedBytes = sum(
      report,
      (sample) => requiredMethod(sample.compressors, method.id).compressedBytes,
    );
    const characters = sum(
      report,
      (sample) => requiredMethod(sample.compressors, method.id).payloadCharacters,
    );
    const compressMilliseconds = sum(
      report,
      (sample) => requiredMethod(sample.compressors, method.id).compressMilliseconds,
    );
    const decompressMilliseconds = sum(
      report,
      (sample) => requiredMethod(sample.compressors, method.id).decompressMilliseconds,
    );
    lines.push(
      `| ${method.id} | ${method.runtime} | ${compressedBytes.toLocaleString("en-US")} | ${characters.toLocaleString("en-US")} | ${percentChange(characters, baselineCompressionCharacters)} | ${fixed(compressMilliseconds)}/${fixed(decompressMilliseconds)} |`,
    );
  }

  const baselineEncodedCharacters = sum(report, (sample) => {
    const result = requiredMethod(sample.encoders, "base64url");
    return result.browserPathCharacters;
  });
  lines.push(
    "",
    "## URL encoding",
    "",
    "Encoding uses the current safe Terser plus fflate output. Browser-path characters use component escaping, which guarantees one reversible path segment. `Direct` means the raw alphabet also survives WHATWG URL parsing without becoming a query, fragment, or extra path segment.",
    "",
    "| Encoder | Base | Safety tier | Raw chars | Browser-path chars | vs base64url | Direct | Encode/decode ms |",
    "| --- | ---: | --- | ---: | ---: | ---: | :---: | ---: |",
  );
  for (const method of ENCODERS) {
    const encodedCharacters = sum(
      report,
      (sample) => requiredMethod(sample.encoders, method.id).encodedCharacters,
    );
    const browserCharacters = sum(
      report,
      (sample) => requiredMethod(sample.encoders, method.id).browserPathCharacters,
    );
    const encodeMilliseconds = sum(
      report,
      (sample) => requiredMethod(sample.encoders, method.id).encodeMilliseconds,
    );
    const decodeMilliseconds = sum(
      report,
      (sample) => requiredMethod(sample.encoders, method.id).decodeMilliseconds,
    );
    const direct = report.samples.every(
      (sample) => requiredMethod(sample.encoders, method.id).directPathSafe,
    );
    lines.push(
      `| ${method.id} | ${method.alphabetSize} | ${method.safety} | ${encodedCharacters.toLocaleString("en-US")} | ${browserCharacters.toLocaleString("en-US")} | ${percentChange(browserCharacters, baselineEncodedCharacters)} | ${direct ? "yes" : "no"} | ${fixed(encodeMilliseconds)}/${fixed(decodeMilliseconds)} |`,
    );
  }

  const baselineCombination = report.combinations.find(
    (combination) =>
      combination.minifier === "terser-current-safe" &&
      combination.compressor === "fflate-deflate-raw-9" &&
      combination.encoder === "base64url",
  );
  if (!baselineCombination) {
    throw new Error("The baseline combination is missing.");
  }
  const topComponentSafe = report.combinations
    .filter((combination) => combination.encodingSafety !== "path")
    .slice(0, 8);
  const topDirect = [...report.combinations]
    .filter((combination) => combination.directPathSafe)
    .sort((left, right) => left.rawPayloadCharacters - right.rawPayloadCharacters)
    .slice(0, 8);
  lines.push(
    "",
    "## Full end-to-end combinations",
    "",
    "This is the complete matrix of plausible schema candidates after pruning the individually dominated no-minification, no-compression, hex, base85, and base91 diagnostics. Every total includes one schema character, the JSON envelope, and all seven corpus files. A separate version plus schema character would add one character per link without changing the ranking.",
    "",
    "### Shortest component-safe combinations",
    "",
    "| Minifier | Compressor | Encoder | Payload chars | vs current |",
    "| --- | --- | --- | ---: | ---: |",
  );
  for (const combination of topComponentSafe) {
    lines.push(
      `| ${combination.minifier} | ${combination.compressor} | ${combination.encoder} | ${combination.componentPayloadCharacters.toLocaleString("en-US")} | ${percentChange(combination.componentPayloadCharacters, baselineCombination.componentPayloadCharacters)} |`,
    );
  }
  lines.push(
    "",
    "### Shortest raw browser-path combinations",
    "",
    "These values are valid as one direct WHATWG browser path segment but may contain punctuation that is fragile in other link-sharing contexts.",
    "",
    "| Minifier | Compressor | Encoder | Payload chars | vs current |",
    "| --- | --- | --- | ---: | ---: |",
  );
  for (const combination of topDirect) {
    lines.push(
      `| ${combination.minifier} | ${combination.compressor} | ${combination.encoder} | ${combination.rawPayloadCharacters.toLocaleString("en-US")} | ${percentChange(combination.rawPayloadCharacters, baselineCombination.rawPayloadCharacters)} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

const report = await benchmark();
const rendered = markdown(report);
await mkdir(OUTPUT_DIRECTORY, { recursive: true });
await writeFile(join(OUTPUT_DIRECTORY, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(OUTPUT_DIRECTORY, "latest.md"), rendered);
process.stdout.write(rendered);
