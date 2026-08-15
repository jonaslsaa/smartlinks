import type {
  ArrowFunctionExpression,
  AssignmentPattern,
  CallExpression,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  Literal,
  Node,
  ObjectPattern,
  TemplateLiteral,
} from "acorn";

export type CompileClosure = ArrowFunctionExpression | FunctionExpression | FunctionDeclaration;

export type Replacement = {
  start: number;
  end: number;
  value: string;
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

export function walkAst(
  node: Node,
  visit: (node: Node, parent: Node | undefined) => boolean | undefined,
  parent?: Node,
): void {
  if (visit(node, parent) === false) {
    return;
  }
  for (const child of childNodes(node)) {
    walkAst(child, visit, node);
  }
}

export function isCompileClosure(node: Node): node is CompileClosure {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

export function isIdentifier(node: Node | null | undefined): node is Identifier {
  return node?.type === "Identifier";
}

export function staticPropertyName(node: Node, computed: boolean): string | undefined {
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

export function destructuresCompile(node: Node): boolean {
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

export function directCallReference(identifier: object, parent: Node | undefined): boolean {
  return parent?.type === "CallExpression" && (parent as CallExpression).callee === identifier;
}

export function applyReplacements(
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
