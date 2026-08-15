import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parse } from "acorn";
import { deflateSync } from "fflate";
import { toBase64Url } from "../src/shared/bytes.js";
import { loadCorpus } from "./corpus.js";
import { MINIFIERS } from "./methods.js";

const DEFAULT_COMPILER = "/tmp/smartlinks-quickjs-f1139494/smartlinks-bytecode-compiler";
const QUICKJS_COMMIT = "f1139494d18a2053630c5ed3384a42bb70db3c53";
const WORK_DIRECTORY = "/tmp/smartlinks-quickjs-bytecode";
const SOURCE_PATH = join(WORK_DIRECTORY, "smartlink.js");
const BYTECODE_PATH = join(WORK_DIRECTORY, "smartlink.bin");
const utf8 = new TextEncoder();

type SampleResult = {
  id: string;
  originalBytes: number;
  minifiedBytes: number;
  bytecodeBytes: number;
  sourcePayloadCharacters: number;
  bytecodePayloadCharacters: number;
  compressedBytecodePayloadCharacters: number;
  qjscMilliseconds: number;
};

function payloadCharacters(bytes: Uint8Array): number {
  return 1 + toBase64Url(bytes).length;
}

function currentPayloadCharacters(source: string): number {
  const envelope = utf8.encode(JSON.stringify({ s: source }));
  return payloadCharacters(deflateSync(envelope, { level: 9 }));
}

function withoutExternalModules(source: string): string {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const ranges = program.body
    .filter(
      (node) =>
        node.type === "ImportDeclaration" ||
        ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
          node.source !== null),
    )
    .map((node) => ({ start: node.start, end: node.end }))
    .sort((left, right) => right.start - left.start);
  let normalized = source;
  for (const range of ranges) {
    normalized = normalized.slice(0, range.start) + normalized.slice(range.end);
  }
  return normalized;
}

function percentChange(value: number, baseline: number): string {
  const change = ((value - baseline) / baseline) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
}

function compileBytecode(
  compiler: string,
  source: string,
): Promise<{
  bytecode: Uint8Array;
  milliseconds: number;
}> {
  return writeFile(SOURCE_PATH, source).then(async () => {
    const timings: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      execFileSync(compiler, ["smartlink.js", "smartlink.bin"], {
        cwd: WORK_DIRECTORY,
        stdio: "pipe",
      });
      timings.push(performance.now() - started);
    }
    timings.sort((left, right) => left - right);
    return { bytecode: await readFile(BYTECODE_PATH), milliseconds: timings[2] ?? 0 };
  });
}

function total(results: SampleResult[], select: (sample: SampleResult) => number): number {
  return results.reduce((sum, sample) => sum + select(sample), 0);
}

function markdown(results: SampleResult[], compiler: string): string {
  const sourceTotal = total(results, (sample) => sample.sourcePayloadCharacters);
  const rawBytecodeTotal = total(results, (sample) => sample.bytecodePayloadCharacters);
  const compressedBytecodeTotal = total(
    results,
    (sample) => sample.compressedBytecodePayloadCharacters,
  );
  const lines = [
    "# QuickJS bytecode size benchmark",
    "",
    `QuickJS commit: \`${QUICKJS_COMMIT}\` (the exact revision named by the bundled \`@jitl/quickjs-wasmfile-release-sync@0.32.0\` package).`,
    `Compiler: \`${compiler}\`, using \`COMPILE_ONLY\`, \`JS_STRIP_DEBUG\`, and \`JS_WriteObject\`; the source filename is always \`smartlink.js\`.`,
    "",
    "The source baseline is: safe Terser -> JSON `{ s }` envelope -> raw DEFLATE level 9 -> base64url. The bytecode variants omit the JSON envelope and are therefore optimistic lower bounds for a real schema that also carries flags and sealed secrets. Every payload count includes one schema/version character.",
    "Top-level imports and re-exports are removed before measuring both variants because the pinned corpus intentionally lacks its dependency tree. Five samples have no imports; this only normalizes the two dependency-bearing modules and does not make the corpus executable as Smartlinks.",
    "Compile time is the median of five native compiler subprocess wall-time runs. It includes process startup, serialization, a verification deserialization, and writing the output; it is not CPU-cycle data or a browser-Wasm measurement.",
    "",
    "| Sample | Original | Minified | Bytecode | Current source URL | Raw bytecode URL | Deflated bytecode URL | Deflated delta | compile |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const sample of results) {
    lines.push(
      `| ${sample.id} | ${sample.originalBytes.toLocaleString()} B | ${sample.minifiedBytes.toLocaleString()} B | ${sample.bytecodeBytes.toLocaleString()} B | ${sample.sourcePayloadCharacters.toLocaleString()} | ${sample.bytecodePayloadCharacters.toLocaleString()} | ${sample.compressedBytecodePayloadCharacters.toLocaleString()} | ${percentChange(sample.compressedBytecodePayloadCharacters, sample.sourcePayloadCharacters)} | ${sample.qjscMilliseconds.toFixed(2)} ms |`,
    );
  }

  lines.push(
    `| **Total** | **${total(results, (sample) => sample.originalBytes).toLocaleString()} B** | **${total(results, (sample) => sample.minifiedBytes).toLocaleString()} B** | **${total(results, (sample) => sample.bytecodeBytes).toLocaleString()} B** | **${sourceTotal.toLocaleString()}** | **${rawBytecodeTotal.toLocaleString()}** | **${compressedBytecodeTotal.toLocaleString()}** | **${percentChange(compressedBytecodeTotal, sourceTotal)}** | **${total(results, (sample) => sample.qjscMilliseconds).toFixed(2)} ms** |`,
    "",
    "Raw QuickJS bytecode is version-specific and cannot currently be serialized or loaded through quickjs-emscripten's public API. Using it in Smartlinks would require maintaining a native FFI addition and treating a QuickJS upgrade as a payload-schema migration.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const compiler = process.env.QJS_BYTECODE_COMPILER ?? DEFAULT_COMPILER;
  await mkdir(WORK_DIRECTORY, { recursive: true });
  const minifier = MINIFIERS.find((candidate) => candidate.id === "terser-current-safe");
  if (!minifier) {
    throw new Error("The safe Terser benchmark method is missing.");
  }

  const results: SampleResult[] = [];
  for (const sample of await loadCorpus()) {
    const minified = withoutExternalModules(await minifier.minify(sample.source));
    const compiled = await compileBytecode(compiler, minified);
    const compressedBytecode = deflateSync(compiled.bytecode, { level: 9 });
    results.push({
      id: sample.id,
      originalBytes: utf8.encode(sample.source).byteLength,
      minifiedBytes: utf8.encode(minified).byteLength,
      bytecodeBytes: compiled.bytecode.byteLength,
      sourcePayloadCharacters: currentPayloadCharacters(minified),
      bytecodePayloadCharacters: payloadCharacters(compiled.bytecode),
      compressedBytecodePayloadCharacters: payloadCharacters(compressedBytecode),
      qjscMilliseconds: compiled.milliseconds,
    });
  }

  const report = markdown(results, compiler);
  await writeFile(join("benchmark", "results", "quickjs-bytecode-latest.md"), report);
  process.stdout.write(report);
}

await main();
