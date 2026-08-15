import {
  type AssignmentExpression,
  type AssignmentPattern,
  type BlockStatement,
  type CallExpression,
  type Expression,
  type MemberExpression,
  type Node,
  type Program,
  parse,
  type VariableDeclarator,
} from "acorn";
import { analyze, type Scope, type ScopeManager, type Variable } from "eslint-scope";
import {
  applyReplacements,
  type CompileClosure,
  destructuresCompile,
  isCompileClosure,
  isIdentifier,
  type Replacement,
  staticPropertyName,
  walkAst,
} from "./compile-ast.js";
import {
  createClosurePackager,
  createTopLevelDeclarationCatalog,
  type TopLevelDeclarationCatalog,
} from "./compile-dependencies.js";

const WRAPPER_PREFIX = "async ctx=>{";
const WRAPPER_SUFFIX = "\n}";
const INDIRECT_COMPILE_ERROR =
  "Call ctx.compile(...) directly; the compile method cannot be aliased, destructured, or passed as a value.";

type WrapperFunction = Extract<Expression, { type: "ArrowFunctionExpression" }> & {
  body: BlockStatement;
};

export type ExtractedCompileSource = {
  source: string;
  closures: string[];
};

function wrapperScope(program: Program, scopes: ScopeManager): Scope {
  const scope = scopes.acquire(wrapperFunction(program), true);
  if (!scope) {
    throw new Error("Could not analyze the Smartlinks entry scope.");
  }
  return scope;
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

function contextBinding(scope: Scope): Variable {
  const context = scope.set.get("ctx");
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
  walkAst(program, (node, parent) => {
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
  walkAst(program, (node) => {
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
  declarations: TopLevelDeclarationCatalog,
  references: ReadonlyMap<object, Variable | null>,
): CompileClosure {
  if (isCompileClosure(argument)) {
    return argument;
  }
  if (!isIdentifier(argument)) {
    throw new Error("ctx.compile requires a function reference as its first argument.");
  }
  const declaration = declarations.byName.get(argument.name);
  if (!declaration || declaration.root.kind === "not-function") {
    throw new Error(
      `Could not statically resolve compile closure ${argument.name}. Pass an inline function or a top-level const/function declaration.`,
    );
  }
  if (references.get(argument) !== declaration.binding) {
    throw new Error(
      `Compile closure ${argument.name} is shadowed or is not the top-level declaration with that name.`,
    );
  }
  if (declaration.root.kind === "mutable") {
    throw new Error(
      `Compile closure ${argument.name} must be a top-level const or an unmodified function declaration.`,
    );
  }
  return declaration.root.closure;
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
  const wrapper = wrapperFunction(program);
  const scope = wrapperScope(program, scopes);
  const context = contextBinding(scope);
  const references = resolvedReferences(scopes);
  const parents = nodeParents(program);
  assertNoDirectEvalWithCompile(program, context, references);
  const declarations = createTopLevelDeclarationCatalog(wrapper.body, scope);
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
      walkAst(closure, (node, parent) => {
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
    const closure = resolveClosure(argument, declarations, references);
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

  walkAst(program, (node, parent) => {
    processCompileNode(node, parent, context);
    return undefined;
  });

  const bodyStart = WRAPPER_PREFIX.length;
  const bodyEnd = bodyStart + source.length;
  const packageClosure = createClosurePackager({
    source: wrapped,
    replacements,
    scopes,
    declarations,
    parents,
    compileArguments,
    parentContext: context,
  });
  return {
    source: applyReplacements(wrapped, bodyStart, bodyEnd, replacements),
    closures: closures.map((closure) =>
      packageClosure(closure, declarations.byClosure.get(closure)),
    ),
  };
}
