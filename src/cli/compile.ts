import {
  type ArrowFunctionExpression,
  type AssignmentExpression,
  type AssignmentPattern,
  type BlockStatement,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type Literal,
  type MemberExpression,
  type Node,
  type ObjectPattern,
  type Program,
  parse,
  type TemplateLiteral,
  type VariableDeclarator,
} from "acorn";
import { analyze, type Scope, type ScopeManager, type Variable } from "eslint-scope";

const WRAPPER_PREFIX = "async ctx=>{";
const WRAPPER_SUFFIX = "\n}";
const INDIRECT_COMPILE_ERROR =
  "Call ctx.compile(...) directly; the compile method cannot be aliased, destructured, or passed as a value.";

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
  name: string;
  closure: CompileClosure;
  binding: Variable;
  mutable: boolean;
};

type StaticDependency = {
  name: string;
  binding: Variable;
  declaration: FunctionDeclaration | VariableDeclarator;
  function?: CompileClosure;
  kind?: "function" | "primitive";
  reason?: string;
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

function walk(
  node: Node,
  visit: (node: Node, parent: Node | undefined) => boolean | undefined,
  parent?: Node,
): void {
  if (visit(node, parent) === false) {
    return;
  }
  for (const child of childNodes(node)) {
    walk(child, visit, node);
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
        name: statement.id.name,
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
          name: declaration.id.name,
          closure,
          binding,
          mutable: statement.kind !== "const" || isReassigned(binding),
        });
      }
    }
  }
  return closures;
}

function primitiveInitializer(expression: Expression | null | undefined): boolean {
  if (!expression) {
    return false;
  }
  if (expression.type === "TemplateLiteral") {
    return expression.expressions.length === 0;
  }
  if (expression.type === "Literal") {
    return (
      expression.regex === undefined &&
      (expression.value === null ||
        typeof expression.value === "string" ||
        typeof expression.value === "number" ||
        typeof expression.value === "boolean" ||
        typeof expression.value === "bigint")
    );
  }
  if (
    expression.type === "UnaryExpression" &&
    (expression.operator === "+" || expression.operator === "-") &&
    expression.argument.type === "Literal" &&
    (typeof expression.argument.value === "number" || typeof expression.argument.value === "bigint")
  ) {
    return true;
  }
  return false;
}

function dependencyReason(expression: Expression | null | undefined): string {
  if (!expression) {
    return "has no initializer";
  }
  if (
    expression.type === "ArrayExpression" ||
    expression.type === "ObjectExpression" ||
    (expression.type === "Literal" && expression.regex !== undefined)
  ) {
    return "has a mutable object initializer";
  }
  if (expression.type === "FunctionExpression" && expression.id) {
    return "uses a named function expression";
  }
  return "has a computed initializer";
}

function staticDependencies(
  program: Program,
  scopes: ScopeManager,
): ReadonlyMap<Variable, StaticDependency> {
  const wrapper = wrapperFunction(program);
  const scope = wrapperScope(program, scopes);
  const dependencies = new Map<Variable, StaticDependency>();

  for (const statement of wrapper.body.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      const binding = scope.set.get(statement.id.name);
      if (!binding) {
        throw new Error(`Could not analyze top-level declaration ${statement.id.name}.`);
      }
      dependencies.set(binding, {
        name: statement.id.name,
        binding,
        declaration: statement,
        function: statement,
        ...(isReassigned(binding) ? { reason: "is reassigned" } : { kind: "function" as const }),
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
      const binding = scope.set.get(declaration.id.name);
      if (!binding) {
        throw new Error(`Could not analyze top-level declaration ${declaration.id.name}.`);
      }
      const candidate = functionFromExpression(declaration.init);
      const common = {
        name: declaration.id.name,
        binding,
        declaration,
      };
      if (statement.kind !== "const" || isReassigned(binding)) {
        dependencies.set(binding, { ...common, reason: "is mutable or reassigned" });
      } else if (candidate && !(candidate.type === "FunctionExpression" && candidate.id)) {
        dependencies.set(binding, {
          ...common,
          function: candidate,
          kind: "function",
        });
      } else if (primitiveInitializer(declaration.init)) {
        dependencies.set(binding, { ...common, kind: "primitive" });
      } else {
        dependencies.set(binding, {
          ...common,
          reason: dependencyReason(declaration.init),
        });
      }
    }
  }

  return dependencies;
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

function nodeParents(program: Program): ReadonlyMap<object, Node | undefined> {
  const parents = new Map<object, Node | undefined>();
  walk(program, (node, parent) => {
    parents.set(node, parent);
    return undefined;
  });
  return parents;
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

function compileMember(
  node: Node,
  context: Variable,
  references: ReadonlyMap<object, Variable | null>,
): node is MemberExpression {
  if (node.type !== "MemberExpression") {
    return false;
  }
  const member = node as MemberExpression;
  const objectBinding = isIdentifier(member.object) ? references.get(member.object) : undefined;
  return (
    objectBinding === context && staticPropertyName(member.property, member.computed) === "compile"
  );
}

function staticPropertyName(node: Node, computed: boolean): string | undefined {
  if (!computed && isIdentifier(node)) {
    return node.name;
  }
  if (node.type === "Literal") {
    const value = (node as Literal).value;
    return typeof value === "string" ? value : undefined;
  }
  if (node.type === "TemplateLiteral") {
    const template = node as TemplateLiteral;
    return template.expressions.length === 0 && template.quasis.length === 1
      ? (template.quasis[0]?.value.cooked ?? undefined)
      : undefined;
  }
  return undefined;
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
  return compileMember(call.callee, context, references) && !call.callee.computed;
}

function destructuresCompile(node: Node): boolean {
  if (node.type === "AssignmentPattern") {
    return destructuresCompile((node as AssignmentPattern).left);
  }
  if (node.type !== "ObjectPattern") {
    return false;
  }
  const pattern = node as ObjectPattern;
  return pattern.properties.some(
    (property) =>
      property.type === "Property" &&
      staticPropertyName(property.key, property.computed) === "compile",
  );
}

function destructuresContextCompile(
  node: Node,
  context: Variable,
  references: ReadonlyMap<object, Variable | null>,
): boolean {
  if (node.type === "VariableDeclarator") {
    const declaration = node as VariableDeclarator;
    return (
      isIdentifier(declaration.init) &&
      references.get(declaration.init) === context &&
      destructuresCompile(declaration.id)
    );
  }
  if (node.type === "AssignmentExpression") {
    const assignment = node as AssignmentExpression;
    return (
      isIdentifier(assignment.right) &&
      references.get(assignment.right) === context &&
      destructuresCompile(assignment.left)
    );
  }
  return false;
}

function assertDirectCompileAccess(
  node: Node,
  parent: Node | undefined,
  context: Variable,
  references: ReadonlyMap<object, Variable | null>,
): void {
  const member = compileMember(node, context, references) ? node : undefined;
  const call = parent?.type === "CallExpression" ? (parent as CallExpression) : undefined;
  const directCall = member && call?.callee === member && !member.computed;
  const destructuresContext = destructuresContextCompile(node, context, references);

  if ((member && !directCall) || destructuresContext) {
    throw new Error(INDIRECT_COMPILE_ERROR);
  }
}

function closureContextBinding(
  closure: CompileClosure,
  scopes: ScopeManager,
): Variable | undefined {
  const parameter = closure.params[0];
  if (!parameter) {
    throw new Error("Compile closures must accept the child context as their first parameter.");
  }
  if (destructuresCompile(parameter)) {
    throw new Error(INDIRECT_COMPILE_ERROR);
  }
  const identifier =
    parameter.type === "AssignmentPattern" ? (parameter as AssignmentPattern).left : parameter;
  if (!isIdentifier(identifier)) {
    return undefined;
  }
  const scope = scopes.acquire(closure, true);
  const binding = scope?.set.get(identifier.name);
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

function directCallReference(identifier: object, parent: Node | undefined): boolean {
  return parent?.type === "CallExpression" && (parent as CallExpression).callee === identifier;
}

function dependencyDeclarationSource(
  dependency: StaticDependency,
  source: string,
  replacements: readonly Replacement[],
): string {
  const declaration = applyReplacements(
    source,
    dependency.declaration.start,
    dependency.declaration.end,
    replacements,
  );
  return dependency.declaration.type === "FunctionDeclaration"
    ? declaration
    : `const ${declaration};`;
}

function packageClosure(
  closure: CompileClosure,
  named: NamedClosure | undefined,
  source: string,
  replacements: readonly Replacement[],
  scopes: ScopeManager,
  dependencies: ReadonlyMap<Variable, StaticDependency>,
  parents: ReadonlyMap<object, Node | undefined>,
  compileArguments: ReadonlySet<object>,
  parentContext: Variable,
): string {
  const selected = new Map<Variable, StaticDependency>();
  const visiting = new Set<Variable>();
  const visited = new Set<CompileClosure>();
  const captures = new Set<string>();
  const rootBinding = named?.binding;
  const rootLabel = named?.name ?? "inline closure";

  function assertCallOnly(dependency: StaticDependency): void {
    for (const reference of dependency.binding.references) {
      if (!reference.isRead()) {
        continue;
      }
      const identifier = reference.identifier;
      if (
        directCallReference(identifier, parents.get(identifier)) ||
        compileArguments.has(identifier)
      ) {
        continue;
      }
      const line = identifier.loc?.start.line;
      throw new Error(
        `Packaged helper ${dependency.name} must only be called directly${line === undefined ? "" : `; found a non-call reference on line ${line}`}.`,
      );
    }
  }

  function rejectDependency(path: readonly string[], dependency: StaticDependency): never {
    const chain = [...path, dependency.name].join(" -> ");
    throw new Error(
      `Compile closure dependency ${chain} is unavailable because ${dependency.name} ${dependency.reason ?? "is not statically packageable"}.`,
    );
  }

  function includeDependency(dependency: StaticDependency, path: readonly string[]): void {
    if (!dependency.kind) {
      if (path.length === 1) {
        captures.add(dependency.name);
        return;
      }
      rejectDependency(path, dependency);
    }

    selected.set(dependency.binding, dependency);
    if (dependency.kind !== "function" || !dependency.function) {
      return;
    }
    if (dependency.binding !== rootBinding) {
      assertCallOnly(dependency);
    }
    if (visiting.has(dependency.binding)) {
      return;
    }
    visiting.add(dependency.binding);
    inspectFunction(dependency.function, [...path, dependency.name]);
    visiting.delete(dependency.binding);
  }

  function inspectFunction(current: CompileClosure, path: readonly string[]): void {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    const scope = scopes.acquire(current, true);
    if (!scope) {
      throw new Error("Could not analyze a compile closure's lexical scope.");
    }
    for (const reference of scope.through) {
      if (insideNestedReplacement(reference.identifier.range, current, replacements)) {
        continue;
      }
      if (reference.resolved === null && ALLOWED_GLOBALS.has(reference.identifier.name)) {
        continue;
      }
      if (reference.resolved === parentContext) {
        if (path.length === 1) {
          captures.add(reference.identifier.name);
          continue;
        }
        throw new Error(
          `Compile closure dependency ${path.join(" -> ")} references the parent ctx.`,
        );
      }
      const dependency =
        reference.resolved === null ? undefined : dependencies.get(reference.resolved);
      if (!dependency) {
        if (path.length === 1) {
          captures.add(reference.identifier.name);
          continue;
        }
        throw new Error(
          `Compile closure dependency ${path.join(" -> ")} captures ${reference.identifier.name}, which is not statically packageable.`,
        );
      }
      includeDependency(dependency, path);
    }
  }

  if (rootBinding) {
    visiting.add(rootBinding);
  }
  inspectFunction(closure, [rootLabel]);
  if (rootBinding) {
    visiting.delete(rootBinding);
  }

  if (captures.size) {
    throw new Error(
      `Compile closures cannot capture outer variables: ${[...captures].sort().join(", ")}. Pass them in the argument tuple instead.`,
    );
  }

  const closureSource = applyReplacements(source, closure.start, closure.end, replacements);
  if (!selected.size) {
    return closureSource;
  }

  const rootDependency = rootBinding ? dependencies.get(rootBinding) : undefined;
  const packageRootByName = rootDependency?.kind === "function";
  if (packageRootByName && rootDependency) {
    selected.set(rootDependency.binding, rootDependency);
  }
  const declarations = [...selected.values()]
    .sort((left, right) => left.declaration.start - right.declaration.start)
    .map((dependency) => dependencyDeclarationSource(dependency, source, replacements));
  const result = packageRootByName && named ? named.name : closureSource;
  return `(()=>{${declarations.join("\n")}\nreturn ${result};})()`;
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
    locations: true,
  });
  const scopes = analyze(program, {
    ecmaVersion: 2022,
    sourceType: "script",
    optimistic: false,
    ignoreEval: false,
  });
  const context = contextBinding(program, scopes);
  const references = resolvedReferences(scopes);
  const parents = nodeParents(program);
  assertNoDirectEvalWithCompile(program, context, references);
  const available = namedClosures(program, scopes);
  const namedByClosure = new Map(
    [...available.values()].map((named) => [named.closure, named] as const),
  );
  const dependencies = staticDependencies(program, scopes);
  const closures: CompileClosure[] = [];
  const indexes = new Map<CompileClosure, number>();
  const replacements: Replacement[] = [];
  const compileArguments = new Set<object>();

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
      walk(closure, (node, parent) => {
        processCompileNode(node, parent, childContext);
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
    if (isIdentifier(argument)) {
      compileArguments.add(argument);
    }
    replacements.push({
      start: argument.start,
      end: argument.end,
      value: String(registerClosure(closure)),
    });
  }

  function processCompileNode(
    node: Node,
    parent: Node | undefined,
    currentContext: Variable,
  ): void {
    assertDirectCompileAccess(node, parent, currentContext, references);
    processCompileCall(node, currentContext);
  }

  walk(program, (node, parent) => {
    processCompileNode(node, parent, context);
    return undefined;
  });

  const bodyStart = WRAPPER_PREFIX.length;
  const bodyEnd = bodyStart + source.length;
  return {
    source: applyReplacements(wrapped, bodyStart, bodyEnd, replacements),
    closures: closures.map((closure) =>
      packageClosure(
        closure,
        namedByClosure.get(closure),
        wrapped,
        replacements,
        scopes,
        dependencies,
        parents,
        compileArguments,
        context,
      ),
    ),
  };
}
