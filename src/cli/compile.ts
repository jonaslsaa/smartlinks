import {
  type ArrowFunctionExpression,
  type BlockStatement,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type Node,
  type Program,
  parse,
} from "acorn";
import { analyze, type ScopeManager } from "eslint-scope";

const WRAPPER_PREFIX = "async ctx=>{";
const WRAPPER_SUFFIX = "\n}";

const ALLOWED_GLOBALS = new Set([
  "Array",
  "ArrayBuffer",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "EvalError",
  "Function",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint8Array",
  "WeakMap",
  "WeakSet",
  "ctx",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "fetch",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
  "unescape",
]);

type CompileClosure = ArrowFunctionExpression | FunctionExpression | FunctionDeclaration;
type WrapperFunction = ArrowFunctionExpression & { body: BlockStatement };

type Replacement = {
  start: number;
  end: number;
  value: string;
};

type NamedClosure = {
  closure: CompileClosure;
  mutable: boolean;
};

export type ExtractedCompileSource = {
  source: string;
  closures: string[];
};

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "object" && entry !== null && "type" in entry) {
          children.push(entry);
        }
      }
    } else if (typeof value === "object" && value !== null && "type" in value) {
      children.push(value);
    }
  }
  return children;
}

function walk(node: Node, visit: (node: Node) => boolean | undefined): void {
  if (visit(node) === false) {
    return;
  }
  for (const child of childNodes(node)) {
    walk(child, visit);
  }
}

function isFunction(node: Node): node is CompileClosure {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

function isIdentifier(node: Node | null | undefined): node is Identifier {
  return node?.type === "Identifier";
}

function functionFromExpression(
  expression: Expression | null | undefined,
): CompileClosure | undefined {
  return expression && isFunction(expression) ? expression : undefined;
}

function namedClosures(program: Program): Map<string, NamedClosure> {
  const wrapper = wrapperFunction(program);

  const closures = new Map<string, NamedClosure>();
  for (const statement of wrapper.body.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      closures.set(statement.id.name, { closure: statement, mutable: false });
      continue;
    }
    if (statement.type !== "VariableDeclaration") {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier") {
        continue;
      }
      const closure = functionFromExpression(declaration.init);
      if (closure) {
        closures.set(declaration.id.name, {
          closure,
          mutable: statement.kind !== "const",
        });
      }
    }
  }
  return closures;
}

function wrapperFunction(program: Program): WrapperFunction {
  const expression = program.body[0];
  if (
    expression?.type !== "ExpressionStatement" ||
    expression.expression.type !== "ArrowFunctionExpression" ||
    expression.expression.body.type !== "BlockStatement"
  ) {
    throw new Error("Could not analyze compile closures.");
  }
  return expression.expression as WrapperFunction;
}

function contextReferences(program: Program, scopes: ScopeManager): ReadonlySet<object> {
  const scope = scopes.acquire(wrapperFunction(program), true);
  const context = scope?.set.get("ctx");
  if (!context) {
    throw new Error("Could not analyze the Smartlinks context binding.");
  }
  return new Set(context.references.map((reference) => reference.identifier));
}

function compileCall(node: Node, contexts: ReadonlySet<object>): node is CallExpression {
  if (node.type !== "CallExpression") {
    return false;
  }
  const call = node as CallExpression;
  if (call.callee.type !== "MemberExpression") {
    return false;
  }
  return (
    !call.callee.computed &&
    isIdentifier(call.callee.object) &&
    call.callee.object.name === "ctx" &&
    contexts.has(call.callee.object) &&
    isIdentifier(call.callee.property) &&
    call.callee.property.name === "compile"
  );
}

function resolveClosure(
  argument: Expression,
  available: ReadonlyMap<string, NamedClosure>,
): CompileClosure {
  if (isFunction(argument)) {
    return argument;
  }
  if (!isIdentifier(argument)) {
    throw new Error("ctx.compile requires a function reference as its first argument.");
  }
  const named = available.get(argument.name);
  if (!named) {
    throw new Error(
      `Could not statically resolve compile closure ${argument.name}. Pass an inline function or a top-level const/function declaration.`,
    );
  }
  if (named.mutable) {
    throw new Error(`Compile closure ${argument.name} must be declared with const.`);
  }
  return named.closure;
}

function insideReplacement(
  range: [number, number] | undefined,
  replacements: readonly Replacement[],
): boolean {
  return (
    range !== undefined &&
    replacements.some((replacement) => range[0] >= replacement.start && range[1] <= replacement.end)
  );
}

function assertNoCapturedVariables(
  closure: CompileClosure,
  replacements: readonly Replacement[],
  scopes: ScopeManager,
): void {
  const scope = scopes.acquire(closure, true);
  if (!scope) {
    throw new Error("Could not analyze a compile closure's lexical scope.");
  }
  const captures = new Set<string>();
  for (const reference of scope.through) {
    if (
      !insideReplacement(reference.identifier.range, replacements) &&
      !ALLOWED_GLOBALS.has(reference.identifier.name)
    ) {
      captures.add(reference.identifier.name);
    }
  }
  if (captures.size) {
    throw new Error(
      `Compile closures cannot capture outer variables: ${[...captures].sort().join(", ")}. Pass them in the argument tuple instead.`,
    );
  }
}

function applyReplacements(
  source: string,
  rangeStart: number,
  rangeEnd: number,
  replacements: readonly Replacement[],
): string {
  let result = source.slice(rangeStart, rangeEnd);
  const contained = replacements
    .filter(
      (replacement) =>
        replacement.start >= rangeStart &&
        replacement.end <= rangeEnd &&
        !(replacement.start === rangeStart && replacement.end === rangeEnd),
    )
    .sort((left, right) => right.start - left.start);
  for (const replacement of contained) {
    const start = replacement.start - rangeStart;
    const end = replacement.end - rangeStart;
    result = `${result.slice(0, start)}${replacement.value}${result.slice(end)}`;
  }
  return result;
}

export async function extractCompileClosures(source: string): Promise<ExtractedCompileSource> {
  const wrapped = `${WRAPPER_PREFIX}${source}${WRAPPER_SUFFIX}`;
  const program = parse(wrapped, {
    ecmaVersion: "latest",
    sourceType: "script",
    ranges: true,
  });
  const scopes = analyze(program, {
    ecmaVersion: 2022,
    sourceType: "script",
    optimistic: false,
    ignoreEval: false,
  });
  const contexts = contextReferences(program, scopes);
  const available = namedClosures(program);
  const closures: CompileClosure[] = [];
  const indexes = new Map<CompileClosure, number>();
  const replacements: Replacement[] = [];

  walk(program, (node) => {
    if (!compileCall(node, contexts)) {
      return undefined;
    }
    if (node.arguments.length < 2 || node.arguments.length > 3) {
      throw new Error("ctx.compile expects a closure, an argument tuple, and optional options.");
    }
    const argument = node.arguments[0];
    if (!argument || argument.type === "SpreadElement") {
      throw new Error("ctx.compile requires a closure as its first argument.");
    }
    const closure = resolveClosure(argument, available);
    let index = indexes.get(closure);
    if (index === undefined) {
      index = closures.length;
      closures.push(closure);
      indexes.set(closure, index);
    }
    replacements.push({ start: argument.start, end: argument.end, value: String(index) });
    return undefined;
  });

  for (const closure of closures) {
    assertNoCapturedVariables(closure, replacements, scopes);
  }

  const bodyStart = WRAPPER_PREFIX.length;
  const bodyEnd = bodyStart + source.length;
  return {
    source: applyReplacements(wrapped, bodyStart, bodyEnd, replacements),
    closures: closures.map((closure) =>
      applyReplacements(wrapped, closure.start, closure.end, replacements),
    ),
  };
}
