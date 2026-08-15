import type {
  BlockStatement,
  Expression,
  FunctionDeclaration,
  MemberExpression,
  Node,
  VariableDeclarator,
} from "acorn";
import type { Scope, ScopeManager, Variable } from "eslint-scope";
import {
  applyReplacements,
  type CompileClosure,
  destructuresCompile,
  directCallReference,
  isCompileClosure,
  type Replacement,
  staticPropertyName,
  walkAst,
} from "./compile-ast.js";

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

type RootEligibility =
  | { kind: "eligible"; closure: CompileClosure }
  | { kind: "mutable"; closure: CompileClosure; reason: string }
  | { kind: "not-function"; reason: string };

type DependencyEligibility =
  | { kind: "function"; closure: CompileClosure }
  | { kind: "primitive" }
  | { kind: "unavailable"; reason: string };

export type TopLevelDeclaration = {
  name: string;
  binding: Variable;
  declaration: FunctionDeclaration | VariableDeclarator;
  root: RootEligibility;
  dependency: DependencyEligibility;
};

export type TopLevelDeclarationCatalog = {
  byName: ReadonlyMap<string, TopLevelDeclaration>;
  byBinding: ReadonlyMap<Variable, TopLevelDeclaration>;
  byClosure: ReadonlyMap<CompileClosure, TopLevelDeclaration>;
};

function isReassigned(binding: Variable): boolean {
  return binding.references.some((reference) => reference.isWrite() && !reference.init);
}

function functionFromExpression(
  expression: Expression | null | undefined,
): CompileClosure | undefined {
  return expression && isCompileClosure(expression) ? expression : undefined;
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
  return (
    expression.type === "UnaryExpression" &&
    (expression.operator === "+" || expression.operator === "-") &&
    expression.argument.type === "Literal" &&
    (typeof expression.argument.value === "number" || typeof expression.argument.value === "bigint")
  );
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

function catalogEntry(
  name: string,
  binding: Variable,
  declaration: FunctionDeclaration | VariableDeclarator,
  closure: CompileClosure | undefined,
  mutable: boolean,
): TopLevelDeclaration {
  const root: RootEligibility = closure
    ? mutable
      ? { kind: "mutable", closure, reason: "is mutable or reassigned" }
      : { kind: "eligible", closure }
    : { kind: "not-function", reason: "is not a function" };

  let dependency: DependencyEligibility;
  if (mutable) {
    dependency = { kind: "unavailable", reason: "is mutable or reassigned" };
  } else if (closure && !(closure.type === "FunctionExpression" && closure.id)) {
    dependency = { kind: "function", closure };
  } else if (declaration.type === "VariableDeclarator" && primitiveInitializer(declaration.init)) {
    dependency = { kind: "primitive" };
  } else {
    dependency = {
      kind: "unavailable",
      reason:
        declaration.type === "VariableDeclarator"
          ? dependencyReason(declaration.init)
          : "is not statically packageable",
    };
  }

  return { name, binding, declaration, root, dependency };
}

export function createTopLevelDeclarationCatalog(
  body: BlockStatement,
  scope: Scope,
): TopLevelDeclarationCatalog {
  const byName = new Map<string, TopLevelDeclaration>();
  const byBinding = new Map<Variable, TopLevelDeclaration>();
  const byClosure = new Map<CompileClosure, TopLevelDeclaration>();

  function add(entry: TopLevelDeclaration): void {
    byName.set(entry.name, entry);
    byBinding.set(entry.binding, entry);
    if (entry.root.kind !== "not-function") {
      byClosure.set(entry.root.closure, entry);
    }
  }

  for (const statement of body.body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      const binding = scope.set.get(statement.id.name);
      if (!binding) {
        throw new Error(`Could not analyze top-level declaration ${statement.id.name}.`);
      }
      add(catalogEntry(statement.id.name, binding, statement, statement, isReassigned(binding)));
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
      add(
        catalogEntry(
          declaration.id.name,
          binding,
          declaration,
          functionFromExpression(declaration.init),
          statement.kind !== "const" || isReassigned(binding),
        ),
      );
    }
  }

  return { byName, byBinding, byClosure };
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

function dependencyDeclarationSource(
  declaration: TopLevelDeclaration,
  source: string,
  replacements: readonly Replacement[],
): string {
  const emitted = applyReplacements(
    source,
    declaration.declaration.start,
    declaration.declaration.end,
    replacements,
  );
  return declaration.declaration.type === "FunctionDeclaration" ? emitted : `const ${emitted};`;
}

type ClosurePackagerConfig = {
  source: string;
  replacements: readonly Replacement[];
  scopes: ScopeManager;
  declarations: TopLevelDeclarationCatalog;
  parents: ReadonlyMap<object, Node | undefined>;
  compileArguments: ReadonlySet<object>;
  parentContext: Variable;
};

class PackagingTraversal {
  readonly #selected = new Map<Variable, TopLevelDeclaration>();
  readonly #visiting = new Set<Variable>();
  readonly #visited = new Set<CompileClosure>();
  readonly #captures = new Set<string>();

  constructor(
    private readonly config: ClosurePackagerConfig,
    private readonly closure: CompileClosure,
    private readonly root: TopLevelDeclaration | undefined,
  ) {}

  run(): string {
    if (this.root) {
      this.#visiting.add(this.root.binding);
    }
    this.inspectFunction(this.closure, [this.root?.name ?? "inline closure"]);
    if (this.root) {
      this.#visiting.delete(this.root.binding);
    }

    if (this.#captures.size) {
      throw new Error(
        `Compile closures cannot capture outer variables: ${[...this.#captures].sort().join(", ")}. Pass them in the argument tuple instead.`,
      );
    }

    const closureSource = applyReplacements(
      this.config.source,
      this.closure.start,
      this.closure.end,
      this.config.replacements,
    );
    if (!this.#selected.size) {
      return closureSource;
    }

    const packageRootByName = this.root?.dependency.kind === "function";
    if (packageRootByName && this.root) {
      this.#selected.set(this.root.binding, this.root);
    }
    const declarations = [...this.#selected.values()]
      .sort((left, right) => left.declaration.start - right.declaration.start)
      .map((declaration) =>
        dependencyDeclarationSource(declaration, this.config.source, this.config.replacements),
      );
    const result = packageRootByName && this.root ? this.root.name : closureSource;
    return `(()=>{${declarations.join("\n")}\nreturn ${result};})()`;
  }

  private assertCallOnly(declaration: TopLevelDeclaration): void {
    for (const reference of declaration.binding.references) {
      if (!reference.isRead()) {
        continue;
      }
      const identifier = reference.identifier;
      if (
        directCallReference(identifier, this.config.parents.get(identifier)) ||
        this.config.compileArguments.has(identifier)
      ) {
        continue;
      }
      const line = identifier.loc?.start.line;
      throw new Error(
        `Packaged function ${declaration.name} must only be called directly${line === undefined ? "" : `; found a non-call reference on line ${line}`}.`,
      );
    }
  }

  private assertHelperBody(declaration: TopLevelDeclaration, closure: CompileClosure): void {
    const scope = this.config.scopes.acquire(closure, true);
    const argumentsBinding = scope?.set.get("arguments");
    if (argumentsBinding?.references.some((reference) => reference.isRead())) {
      throw new Error(
        `Packaged helper ${declaration.name} cannot use arguments; declare parameters or a rest parameter instead.`,
      );
    }
    walkAst(closure, (node) => {
      const member = node.type === "MemberExpression" ? (node as MemberExpression) : undefined;
      if (
        (member && staticPropertyName(member.property, member.computed) === "compile") ||
        destructuresCompile(node)
      ) {
        throw new Error(
          `Packaged helper ${declaration.name} cannot access a .compile property; call ctx.compile directly inside the compile closure.`,
        );
      }
      return undefined;
    });
  }

  private rejectDependency(path: readonly string[], declaration: TopLevelDeclaration): never {
    const chain = [...path, declaration.name].join(" -> ");
    const reason =
      declaration.dependency.kind === "unavailable"
        ? declaration.dependency.reason
        : "is not statically packageable";
    throw new Error(
      `Compile closure dependency ${chain} is unavailable because ${declaration.name} ${reason}.`,
    );
  }

  private includeDependency(declaration: TopLevelDeclaration, path: readonly string[]): void {
    const dependency = declaration.dependency;
    if (dependency.kind === "unavailable") {
      if (path.length === 1) {
        this.#captures.add(declaration.name);
        return;
      }
      this.rejectDependency(path, declaration);
    }

    this.#selected.set(declaration.binding, declaration);
    if (dependency.kind === "primitive") {
      return;
    }
    this.assertCallOnly(declaration);
    if (declaration.binding !== this.root?.binding) {
      this.assertHelperBody(declaration, dependency.closure);
    }
    if (this.#visiting.has(declaration.binding)) {
      return;
    }
    this.#visiting.add(declaration.binding);
    this.inspectFunction(dependency.closure, [...path, declaration.name]);
    this.#visiting.delete(declaration.binding);
  }

  private inspectFunction(closure: CompileClosure, path: readonly string[]): void {
    if (this.#visited.has(closure)) {
      return;
    }
    this.#visited.add(closure);
    const scope = this.config.scopes.acquire(closure, true);
    if (!scope) {
      throw new Error("Could not analyze a compile closure's lexical scope.");
    }
    for (const reference of scope.through) {
      if (insideNestedReplacement(reference.identifier.range, closure, this.config.replacements)) {
        continue;
      }
      if (reference.resolved === null && ALLOWED_GLOBALS.has(reference.identifier.name)) {
        continue;
      }
      if (reference.resolved === this.config.parentContext) {
        if (path.length === 1) {
          this.#captures.add(reference.identifier.name);
          continue;
        }
        throw new Error(
          `Compile closure dependency ${path.join(" -> ")} references the parent ctx.`,
        );
      }
      const declaration =
        reference.resolved === null
          ? undefined
          : this.config.declarations.byBinding.get(reference.resolved);
      if (!declaration) {
        if (path.length === 1) {
          this.#captures.add(reference.identifier.name);
          continue;
        }
        throw new Error(
          `Compile closure dependency ${path.join(" -> ")} captures ${reference.identifier.name}, which is not statically packageable.`,
        );
      }
      this.includeDependency(declaration, path);
    }
  }
}

export function createClosurePackager(
  config: ClosurePackagerConfig,
): (closure: CompileClosure, root?: TopLevelDeclaration) => string {
  return (closure, root) => new PackagingTraversal(config, closure, root).run();
}
