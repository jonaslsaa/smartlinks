import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Diagnostic } from "typescript";
import { assertScriptLength } from "../shared/script.js";

type ScriptSourceOptions = { typeCheck?: boolean };

const TYPE_CHECK_PREFIX = `
type __SmartlinksStringMap = { [name: string]: string | undefined };
type __SmartlinksFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
type __SmartlinksFetchResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
};
type __SmartlinksContext = {
  params: __SmartlinksStringMap;
  method: string;
  headers: __SmartlinksStringMap;
  body: string | null;
  secrets: __SmartlinksStringMap;
  fetch(url: string, options?: __SmartlinksFetchOptions): Promise<__SmartlinksFetchResponse>;
};
type __SmartlinksResult =
  | string
  | { status?: number; headers?: Record<string, string>; body?: string; text?: never }
  | void;
async function __smartlinks_entry(ctx: __SmartlinksContext): Promise<__SmartlinksResult> {
`;

function diagnosticLocation(diagnostic: Diagnostic): string {
  if (!diagnostic.file || diagnostic.start === undefined) {
    return "";
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${line + 1}:${character + 1}: `;
}

function typeDiagnosticLocation(
  diagnostic: Diagnostic,
  source: string,
  file: string,
  ts: typeof import("typescript"),
): string {
  if (diagnostic.start === undefined) {
    return "";
  }
  const sourcePosition = diagnostic.start - TYPE_CHECK_PREFIX.length;
  if (sourcePosition < 0 || sourcePosition > source.length) {
    return "";
  }
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(sourcePosition);
  return `${line + 1}:${character + 1}: `;
}

function typeCheckScriptSource(
  source: string,
  file: string,
  ts: typeof import("typescript"),
): void {
  // TypeScript normalizes compiler-host paths to forward slashes, including on Windows.
  const virtualFile = `${resolve(file).replaceAll("\\", "/")}.smartlinks-typecheck.ts`;
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  } satisfies import("typescript").CompilerOptions;
  const wrappedSource = `${TYPE_CHECK_PREFIX}${source}\n}\n`;
  const input = ts.createSourceFile(
    virtualFile,
    wrappedSource,
    compilerOptions.target,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requestedFile, languageVersion, onError, shouldCreateNewSourceFile) =>
    requestedFile === virtualFile
      ? input
      : getSourceFile(requestedFile, languageVersion, onError, shouldCreateNewSourceFile);

  const program = ts.createProgram([virtualFile], compilerOptions, host);
  const error = program
    .getSemanticDiagnostics(input)
    .find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (error) {
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new Error(
      `Could not type-check ${file}: ${typeDiagnosticLocation(error, source, file, ts)}${message}`,
    );
  }
}

export async function transpileScriptSource(
  source: string,
  file: string,
  options: ScriptSourceOptions = {},
): Promise<string> {
  assertScriptLength(source);
  if (extname(file).toLowerCase() !== ".ts") {
    return source;
  }

  const ts = await import("typescript");
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  const error = result.diagnostics?.find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (error) {
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new Error(`Could not transpile ${file}: ${diagnosticLocation(error)}${message}`);
  }
  if (options.typeCheck !== false) {
    typeCheckScriptSource(source, file, ts);
  }
  return result.outputText;
}

export async function readScriptSource(
  file: string,
  options: ScriptSourceOptions = {},
): Promise<string> {
  return transpileScriptSource(await readFile(file, "utf8"), file, options);
}
