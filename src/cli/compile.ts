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
import { analyze, type Scope, type ScopeManager, type Variable } from "eslint-scope";

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
  binding: Variable;
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

function wrapperScope(program: Program, scopes: ScopeManager): Scope {
  const scope = scopes.acquire(wrapperFunction(program), true);
  if (!scope) {
    throw new Error("Could not analyze the Smartlinks entry scope.");
  }
  return scope;
}

function isReassigned(binding: Variable): boolean {
  return binding.references.some((reference) => reference.isWrite() && !reference.init);
}

function namedClosures(program: Program, scopes: ScopeManager): Map<string, NamedClosure> {
  const wrapper = wrapperFunction(program);
  const scope = wrapperScope(program, scopes);

  const closures = new Map<string, NamedClosure>();
  for (const statement of wrapper.body.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      const binding = scope.set.get(statement.id.name);
      if (!binding) {
        throw new Error(`Could not analyze compile closure ${statement.id.name}.`);
      }
      closures.set(statement.id.name, {
        closure: statement,
        binding,
        mutable: isReassigned(binding),
      });
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
        const binding = scope.set.get(declaration.id.name);
        if (!binding) {
          throw new Error(`Could not analyze compile closure ${declaration.id.name}.`);
        }
        closures.set(declaration.id.name, {
          closure,
          binding,
          mutable: statement.kind !== "const" || isReassigned(binding),
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

function contextBinding(program: Program, scopes: ScopeManager): Variable {
  const context = wrapperScope(program, scopes).set.get("ctx");
  if (!context) {
    throw new Error("Could not analyze the Smartlinks context binding.");
  }
  return context;
}

function resolvedReferences(scopes: ScopeManager): ReadonlyMap<object, Variable | null> {
  const references = new Map<object, Variable | null>();
  for (const scope of scopes.scopes) {
    for (const reference of scope.references) {
      references.set(reference.identifier, reference.resolved);
    }
  }
  return references;
}

function assertNoDirectEvalWithCompile(
  program: Program,
  context: Variable,
  references: ReadonlyMap<object, Variable | null>,
): void {
  let directEval = false;
  let compile = false;
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return undefined;
    }
    const call = node as CallExpression;
    if (
      isIdentifier(call.callee) &&
      call.callee.name === "eval" &&
      references.get(call.callee) === null
    ) {
      directEval = true;
    }
    if (
      call.callee.type === "MemberExpression" &&
      !call.callee.computed &&
      isIdentifier(call.callee.object) &&
      call.callee.object.name === "ctx" &&
      (references.get(call.callee.object) === context ||
        references.get(call.callee.object) === null) &&
      isIdentifier(call.callee.property) &&
      call.callee.property.name === "compile"
    ) {
      compile = true;
    }
    return undefined;
  });
  if (directEval && compile) {
    throw new Error(
      "Scripts containing eval(...) calls cannot use ctx.compile because eval prevents static closure analysis.",
    );
  }
}

function compileCall(
  node: Node,
  context: Variable,
  references: ReadonlyMap<object, Variable | null>,
): node is CallExpression {
  if (node.type !== "CallExpression") {
    return false;
  }
  const call = node as CallExpression;
  if (call.callee.type !== "MemberExpression") {
    return false;
  }
  const objectBinding = isIdentifier(call.callee.object)
    ? references.get(call.callee.object)
    : undefined;
  return (
    !call.callee.computed &&
    objectBinding === context &&
    isIdentifier(call.callee.property) &&
    call.callee.property.name === "compile"
  );
}

function closureContextBinding(
  closure: CompileClosure,
  scopes: ScopeManager,
): Variable | undefined {
  const parameter = closure.params[0];
  if (!parameter) {
    throw new Error("Compile closures must accept the child context as their first parameter.");
  }
  if (!isIdentifier(parameter)) {
    return undefined;
  }
  const scope = scopes.acquire(closure, true);
  const binding = scope?.set.get(parameter.name);
  if (!binding) {
    throw new Error("Could not analyze a compile closure's child context binding.");
  }
  return binding;
}

function resolveClosure(
  argument: Expression,
  available: ReadonlyMap<string, NamedClosure>,
  references: ReadonlyMap<object, Variable | null>,
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
  if (references.get(argument) !== named.binding) {
    throw new Error(
      `Compile closure ${argument.name} is shadowed or is not the top-level declaration with that name.`,
    );
  }
  if (named.mutable) {
    throw new Error(
      `Compile closure ${argument.name} must be a top-level const or an unmodified function declaration.`,
    );
  }
  return named.closure;
}

function insideNestedReplacement(
  range: [number, number] | undefined,
  closure: CompileClosure,
  replacements: readonly Replacement[],
): boolean {
  return (
    range !== undefined &&
    replacements.some(
      (replacement) =>
        replacement.start >= closure.start &&
        replacement.end <= closure.end &&
        !(replacement.start === closure.start && replacement.end === closure.end) &&
        range[0] >= replacement.start &&
        range[1] <= replacement.end,
    )
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
    const allowedGlobal =
      reference.resolved === null && ALLOWED_GLOBALS.has(reference.identifier.name);
    if (
      !insideNestedReplacement(reference.identifier.range, closure, replacements) &&
      !allowedGlobal
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
  const contained = replacements.filter(
    (replacement) =>
      replacement.start >= rangeStart &&
      replacement.end <= rangeEnd &&
      !(replacement.start === rangeStart && replacement.end === rangeEnd),
  );
  const outermost = contained
    .filter(
      (candidate) =>
        !contained.some(
          (other) =>
            other !== candidate && candidate.start >= other.start && candidate.end <= other.end,
        ),
    )
    .sort((left, right) => right.start - left.start);
  for (const replacement of outermost) {
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
  const context = contextBinding(program, scopes);
  const references = resolvedReferences(scopes);
  assertNoDirectEvalWithCompile(program, context, references);
  const available = namedClosures(program, scopes);
  const closures: CompileClosure[] = [];
  const indexes = new Map<CompileClosure, number>();
  const replacements: Replacement[] = [];

  function registerClosure(closure: CompileClosure): number {
    const existing = indexes.get(closure);
    if (existing !== undefined) {
      return existing;
    }
    const index = closures.length;
    closures.push(closure);
    indexes.set(closure, index);
    const childContext = closureContextBinding(closure, scopes);
    if (childContext) {
      walk(closure, (node) => {
        processCompileCall(node, childContext);
        return undefined;
      });
    }
    return index;
  }

  function processCompileCall(node: Node, currentContext: Variable): void {
    if (!compileCall(node, currentContext, references)) {
      return;
    }
    if (node.arguments.length < 2 || node.arguments.length > 3) {
      throw new Error("ctx.compile expects a closure, an argument tuple, and optional options.");
    }
    const argument = node.arguments[0];
    if (!argument || argument.type === "SpreadElement") {
      throw new Error("ctx.compile requires a closure as its first argument.");
    }
    const closure = resolveClosure(argument, available, references);
    replacements.push({
      start: argument.start,
      end: argument.end,
      value: String(registerClosure(closure)),
    });
  }

  walk(program, (node) => {
    processCompileCall(node, context);
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
