import { parse } from "acorn";
import { generate } from "astring";
import { minify } from "terser";
import { MAX_SCRIPT_LENGTH, type PayloadVersion } from "./codec.js";

export async function minifyScriptBody(source: string): Promise<string> {
  const wrapped = wrapScriptBody(source);

  const result = await minify(wrapped, {
    compress: { passes: 2, side_effects: false },
    mangle: true,
    ecma: 2022,
    format: { comments: false, semicolons: true },
  });

  const code = result.code?.replace(/;$/u, "");
  if (!code) {
    throw new Error("The script could not be minified.");
  }
  return code;
}

export async function minifyFunctionExpression(source: string): Promise<string> {
  const assignment = "globalThis.__smartlinks_closure=";
  const result = await minify(`${assignment}${source}`, {
    compress: { passes: 2, side_effects: false },
    mangle: true,
    ecma: 2022,
    format: { comments: false, semicolons: true },
  });
  const code = result.code?.replace(/;$/u, "");
  if (!code?.startsWith(assignment)) {
    throw new Error("A compile closure could not be minified.");
  }
  return code.slice(assignment.length);
}

export function assertScriptLength(source: string): void {
  if (source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `The input exceeds the ${MAX_SCRIPT_LENGTH.toLocaleString()} character safety limit. Check that you selected the intended script file.`,
    );
  }
}

export function wrapScriptBody(source: string): string {
  if (!source.trim()) {
    throw new Error("The script is empty.");
  }
  assertScriptLength(source);

  return `async ctx=>{${source}\n}`;
}

export function executableSource(version: PayloadVersion, storedSource: string): string {
  return version === "1"
    ? `(async (ctx) => {${storedSource}\n})(globalThis.__smartlinks_ctx)`
    : `(${storedSource})(globalThis.__smartlinks_ctx)`;
}

export function formatStoredScript(version: PayloadVersion, storedSource: string): string {
  if (version === "1") {
    return storedSource;
  }

  try {
    const program = parse(`(${storedSource})`, { ecmaVersion: "latest" });
    return generate(program).trim();
  } catch {
    return storedSource;
  }
}
