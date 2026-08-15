import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Diagnostic } from "typescript";
import { assertScriptLength } from "../shared/script.js";

function diagnosticLocation(diagnostic: Diagnostic): string {
  if (!diagnostic.file || diagnostic.start === undefined) {
    return "";
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${line + 1}:${character + 1}: `;
}

export async function transpileScriptSource(source: string, file: string): Promise<string> {
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
  return result.outputText;
}

export async function readScriptSource(file: string): Promise<string> {
  return transpileScriptSource(await readFile(file, "utf8"), file);
}
