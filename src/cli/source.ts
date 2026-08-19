import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Diagnostic } from "typescript";
import { assertScriptLength } from "../shared/script.js";

type ScriptSourceOptions = {
  secretNames?: readonly string[];
  typeCheck?: boolean;
};

const TYPE_CHECK_PREAMBLE = `
type __SmartlinksStringMap = { [name: string]: string | undefined };
type __SmartlinksFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
type __SmartlinksFetchResponse = {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly url: string;
  readonly redirected: boolean;
  readonly bodyUsed: boolean;
  readonly headers: {
    get(name: string): string | null;
    has(name: string): boolean;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    forEach(
      callback: (value: string, name: string, headers: __SmartlinksFetchResponse["headers"]) => void,
      thisArg?: unknown,
    ): void;
    [Symbol.iterator](): IterableIterator<[string, string]>;
  };
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
};
declare function btoa(value: string): string;
declare function atob(value: string): string;
declare function fetch(
  url: string,
  options?: __SmartlinksFetchOptions,
): Promise<__SmartlinksFetchResponse>;
type SmartlinksContext = {
  params: __SmartlinksStringMap;
  paramValues: { [name: string]: string[] | undefined };
  method: string;
  headers: __SmartlinksStringMap;
  body: string | null;
  secrets: __SmartlinksStringMap;
  requestId: string;
  crypto: {
    random(byteCount: number, encoding?: "hex" | "base64"): Promise<string>;
    sha256(message: string, encoding?: "hex" | "base64"): Promise<string>;
    hmacSha256(
      key: string,
      message: string,
      encoding?: "hex" | "base64",
    ): Promise<string>;
    verifyHmacSha256(
      key: string,
      message: string,
      signature: string,
      encoding?: "hex" | "base64",
    ): Promise<boolean>;
    seal(
      value: __SmartlinksJson,
      options?: { key?: string; context?: string },
    ): Promise<string>;
    open<T extends __SmartlinksJson = __SmartlinksJson>(
      token: string,
      options?: { key?: string; context?: string },
    ): Promise<T>;
  };
  compile: __SmartlinksCompile;
};
type __SmartlinksContextWithSecrets<Secrets extends __SmartlinksStringMap> = Omit<
  SmartlinksContext,
  "secrets"
> & { secrets: Secrets };
type __SmartlinksLiteralResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  text?: never;
} & ({ bodyBase64?: never } | { body?: never; bodyBase64: string });
type SmartlinksResult = string | __SmartlinksLiteralResponse | void;
type __SmartlinksJson =
  | string
  | number
  | boolean
  | null
  | __SmartlinksJson[]
  | { [name: string]: __SmartlinksJson };
type SmartlinksBrowserSource = "self" | "https" | "all" | \`https://\${string}\`;
type SmartlinksBrowserPolicy = {
  scripts?: SmartlinksBrowserSource[];
  connect?: SmartlinksBrowserSource[];
  images?: SmartlinksBrowserSource[];
  styles?: SmartlinksBrowserSource[];
  fonts?: SmartlinksBrowserSource[];
  media?: SmartlinksBrowserSource[];
  frames?: SmartlinksBrowserSource[];
  forms?: SmartlinksBrowserSource[];
  embeddableBy?: SmartlinksBrowserSource[];
  referrer?: "none" | "origin" | "full";
};
type __SmartlinksCompileBaseOptions = {
  seal?: Record<string, string>;
  ttlSeconds?: number;
  allowCrawlers?: boolean;
  cors?: true;
};
type __SmartlinksCompileOptions =
  | (__SmartlinksCompileBaseOptions & {
      interstitial?: boolean;
      note?: string;
      browser?: SmartlinksBrowserPolicy & { embeddableBy?: never };
    })
  | (__SmartlinksCompileBaseOptions & {
      interstitial: false;
      note?: never;
      browser: SmartlinksBrowserPolicy & {
        embeddableBy: [SmartlinksBrowserSource, ...SmartlinksBrowserSource[]];
      };
    });
type __SmartlinksCompile = <
  const Args extends readonly __SmartlinksJson[],
  ChildSecrets extends __SmartlinksStringMap = __SmartlinksStringMap,
>(
  closure: (
    childContext: __SmartlinksContextWithSecrets<ChildSecrets>,
    ...args: Args
  ) => SmartlinksResult | Promise<SmartlinksResult>,
  args: Args,
  options?: __SmartlinksCompileOptions,
) => Promise<string>;
`;

function typeCheckPrefix(secretNames: readonly string[]): string {
  const context =
    secretNames.length === 0
      ? "SmartlinksContext"
      : `__SmartlinksContextWithSecrets<{ ${secretNames
          .map((name) => `${JSON.stringify(name)}: string;`)
          .join(" ")} }>`;
  return `${TYPE_CHECK_PREAMBLE}async function __smartlinks_entry(ctx: ${context}): Promise<SmartlinksResult> {\n`;
}

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
  prefixLength: number,
  ts: typeof import("typescript"),
): string {
  if (diagnostic.start === undefined) {
    return "";
  }
  const sourcePosition = diagnostic.start - prefixLength;
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
  secretNames: readonly string[],
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
  const prefix = typeCheckPrefix(secretNames);
  const wrappedSource = `${prefix}${source}\n}\n`;
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
      `Could not type-check ${file}: ${typeDiagnosticLocation(error, source, file, prefix.length, ts)}${message}`,
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
    typeCheckScriptSource(source, file, options.secretNames ?? [], ts);
  }
  return result.outputText;
}

export async function readScriptSource(
  file: string,
  options: ScriptSourceOptions = {},
): Promise<string> {
  return transpileScriptSource(await readFile(file, "utf8"), file, options);
}
