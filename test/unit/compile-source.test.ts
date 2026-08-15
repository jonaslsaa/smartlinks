import { describe, expect, it } from "vitest";
import { extractCompileClosures } from "../../src/cli/compile.js";

describe("compile closure extraction", () => {
  it("extracts named closures and rewrites nested compile references", async () => {
    const extracted = await extractCompileClosures(`
      const leaf = async (leafCtx, name) => ({ body: leafCtx.params.prefix + name });
      const child = async (childCtx, name) => childCtx.compile(leaf, [name]);
      return ctx.compile(child, [ctx.params.name ?? "world"]);
    `);

    expect(extracted.closures).toHaveLength(2);
    expect(extracted.closures[0]).toContain("childCtx.compile(1, [name])");
    expect(extracted.closures[1]).toContain("leafCtx.params.prefix + name");
    expect(extracted.source).toContain("ctx.compile(0, [ctx.params.name");
  });

  it("accepts inline closures and ordinary object keys", async () => {
    const extracted = await extractCompileClosures(`
      return ctx.compile(async (childCtx, value) => ({ body: childCtx.requestId + JSON.stringify({ value }) }), ["ok"]);
    `);

    expect(extracted.source).toContain('ctx.compile(0, ["ok"])');
    expect(extracted.closures[0]).toContain("JSON.stringify({ value })");
  });

  it("allows a child context to be destructured when nested compilation is not needed", async () => {
    const extracted = await extractCompileClosures(`
      return ctx.compile(async ({ params }, value) => ({ body: params.prefix + value }), ["ok"]);
    `);

    expect(extracted.closures[0]).toContain("async ({ params }, value)");
  });

  it("rewrites nested inline closures without overlapping replacements", async () => {
    const extracted = await extractCompileClosures(`
      return ctx.compile(
        async (childCtx, name) => childCtx.compile(
          async (leafCtx, value) => ({ body: leafCtx.params.prefix + value }),
          [name],
        ),
        ["Jonas"],
      );
    `);

    expect(extracted.source).toMatch(/ctx\.compile\(\s*0,\s*\["Jonas"\]/u);
    expect(extracted.closures[0]).toMatch(/childCtx\.compile\(\s*1,/u);
    expect(extracted.closures[1]).toContain("leafCtx.params.prefix + value");
  });

  it("packages immutable primitive constants with a named closure", async () => {
    const extracted = await extractCompileClosures(`
      const prefix = "hello";
      const signed = -2;
      const count = 3n;
      const enabled = true;
      const empty = null;
      const template = \`fixed\`;
      const child = async (_childCtx, name) => ({
        body: prefix + name + signed + count + enabled + empty + template,
      });
      return ctx.compile(child, ["Jonas"]);
    `);

    expect(extracted.closures[0]).toContain('const prefix = "hello";');
    expect(extracted.closures[0]).toContain("const signed = -2;");
    expect(extracted.closures[0]).toContain("const count = 3n;");
    expect(extracted.closures[0]).toContain("const enabled = true;");
    expect(extracted.closures[0]).toContain("const empty = null;");
    expect(extracted.closures[0]).toContain("const template = `fixed`;");
    expect(extracted.closures[0]).toContain("return child;");
  });

  it("uses exact lexical bindings when nested parameters shadow packaged constants", async () => {
    const extracted = await extractCompileClosures(`
      const label = "outer";
      const child = async (_childCtx) => {
        const nested = (label) => label;
        return { body: label + nested("inner") };
      };
      return ctx.compile(child, []);
    `);

    expect(extracted.closures[0]).toContain('const label = "outer";');
    expect(extracted.closures[0]).toContain("const nested = (label) => label");
  });

  it("rejects parent bindings that shadow supported child globals", async () => {
    await expect(
      extractCompileClosures(`
        const Math = { max: () => 123 };
        const fetch = async () => ({ ok: true });
        const child = async (_childCtx) => ({ body: String(Math.max()) + String((await fetch()).ok) });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("cannot capture outer variables: Math");
  });

  it("packages transitive helpers and constants in original declaration order", async () => {
    const extracted = await extractCompileClosures(`
      const CSS = ".label { color: red; }";
      const escapeHtml = (value) => value.replaceAll("&", "&amp;");
      function render(value) { return "<style>" + CSS + "</style>" + escapeHtml(value); }
      const child = async (_childCtx, value) => ({ body: render(value) });
      return ctx.compile(child, ["Jonas & Ada"]);
    `);

    const packaged = extracted.closures[0] ?? "";
    expect(packaged).toContain('const CSS = ".label { color: red; }";');
    expect(packaged).toContain("const escapeHtml =");
    expect(packaged).toContain("function render(value)");
    expect(packaged).toContain("return child;");
    expect(packaged.indexOf("const CSS")).toBeLessThan(packaged.indexOf("const escapeHtml"));
    expect(packaged.indexOf("const escapeHtml")).toBeLessThan(packaged.indexOf("function render"));
    expect(packaged.indexOf("function render")).toBeLessThan(packaged.indexOf("const child"));
  });

  it("packages self-recursive and mutually recursive call-only helpers", async () => {
    const extracted = await extractCompileClosures(`
      const factorial = (value) => value < 2 ? 1 : value * factorial(value - 1);
      const even = (value) => value === 0 || odd(value - 1);
      const odd = (value) => value !== 0 && even(value - 1);
      const child = async (_childCtx, value) => ({ body: String(factorial(value)) + even(value) });
      return ctx.compile(child, [4]);
    `);

    const packaged = extracted.closures[0] ?? "";
    expect(packaged).toContain("factorial(value - 1)");
    expect(packaged).toContain("odd(value - 1)");
    expect(packaged).toContain("even(value - 1)");
  });

  it("permits helper references that are themselves statically packaged compile arguments", async () => {
    const extracted = await extractCompileClosures(`
      const leaf = async (_leafCtx) => ({ body: "leaf" });
      const child = async (childCtx) => {
        if (childCtx.params.run === "1") await leaf(childCtx);
        return childCtx.compile(leaf, []);
      };
      return ctx.compile(child, []);
    `);

    expect(extracted.closures).toHaveLength(2);
    expect(extracted.closures[0]).toContain("childCtx.compile(1, [])");
    expect(extracted.closures[0]).toContain("await leaf(childCtx)");
  });

  it("rejects non-call helper observations anywhere in the parent program", async () => {
    await expect(
      extractCompileClosures(`
        const escapeHtml = (value) => value;
        const formatter = escapeHtml;
        const child = async (_childCtx, value) => ({ body: escapeHtml(value) });
        return ctx.compile(child, [formatter("ok")]);
      `),
    ).rejects.toThrow("Packaged helper escapeHtml must only be called directly");

    await expect(
      extractCompileClosures(`
        function escapeHtml(value) { return value; }
        escapeHtml.cache = "parent-state";
        const child = async (_childCtx, value) => ({ body: escapeHtml(value) });
        return ctx.compile(child, ["ok"]);
      `),
    ).rejects.toThrow("Packaged helper escapeHtml must only be called directly");

    await expect(
      extractCompileClosures(`
        function escapeHtml(value) {
          escapeHtml.cache = "internal-state";
          return value;
        }
        const child = async (_childCtx, value) => ({ body: escapeHtml(value) });
        return ctx.compile(child, ["ok"]);
      `),
    ).rejects.toThrow("Packaged helper escapeHtml must only be called directly");
  });

  it("rejects named function expressions and mutable value dependencies", async () => {
    await expect(
      extractCompileClosures(`
        const escapeHtml = function inner(value) { return value; };
        const child = async (_childCtx, value) => ({ body: escapeHtml(value) });
        return ctx.compile(child, ["ok"]);
      `),
    ).rejects.toThrow("cannot capture outer variables: escapeHtml");

    await expect(
      extractCompileClosures(`
        const config = { prefix: "hello" };
        const child = async (_childCtx, value) => ({ body: config.prefix + value });
        return ctx.compile(child, ["ok"]);
      `),
    ).rejects.toThrow("cannot capture outer variables: config");
  });

  it("names transitive dependency failures and parent-context access", async () => {
    await expect(
      extractCompileClosures(`
        const prefix = String(Date.now());
        const escapeHtml = (value) => prefix + value;
        const render = (value) => escapeHtml(value);
        const child = async (_childCtx, value) => ({ body: render(value) });
        return ctx.compile(child, ["ok"]);
      `),
    ).rejects.toThrow(
      "Compile closure dependency child -> render -> escapeHtml -> prefix is unavailable because prefix has a computed initializer",
    );

    await expect(
      extractCompileClosures(`
        const render = () => ctx.params.name ?? "";
        const child = async (_childCtx) => ({ body: render() });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("Compile closure dependency child -> render references the parent ctx");
  });

  it("explains why direct eval cannot be combined with runtime compilation", async () => {
    await expect(
      extractCompileClosures(`
        eval("1 + 1");
        const child = async (_childCtx) => ({ body: "ok" });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("eval(...) calls cannot use ctx.compile");

    await expect(
      extractCompileClosures(`
        const eval = (value) => value;
        eval("data");
        const child = async (_childCtx) => ({ body: "ok" });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("eval(...) calls cannot use ctx.compile");

    const evalOnly = await extractCompileClosures(`return { body: String(eval("1 + 1")) };`);
    expect(evalOnly.closures).toEqual([]);
  });

  it("allows values declared inside the compile closure", async () => {
    const extracted = await extractCompileClosures(`
      const child = async (_childCtx, name) => {
        const greeting = "hello " + name;
        return { body: greeting };
      };
      return ctx.compile(child, ["Jonas"]);
    `);

    expect(extracted.closures[0]).toContain("body: greeting");
  });

  it("ignores compile-like calls on a shadowed context", async () => {
    const extracted = await extractCompileClosures(`
      const invoke = (ctx) => {
        const method = ctx.compile;
        return method("ordinary method");
      };
      return { body: String(invoke({ compile: (value) => value })) };
    `);

    expect(extracted.closures).toEqual([]);
    expect(extracted.source).toContain("const method = ctx.compile");
  });

  it("allows dynamic context keys whose variable happens to be named compile", async () => {
    const extracted = await extractCompileClosures(`
      const compile = "params";
      const name = ctx[compile].name;
      const { [compile]: params } = ctx;
      return { body: name + params.name };
    `);

    expect(extracted.closures).toEqual([]);
    expect(extracted.source).toContain("ctx[compile].name");
    expect(extracted.source).toContain("{ [compile]: params }");
  });

  it.each([
    [
      "an aliased method",
      `
        const child = async (childCtx) => ({ body: childCtx.requestId });
        const compile = ctx.compile;
        return compile(child, []);
      `,
    ],
    [
      "a destructured method",
      `
        const child = async (childCtx) => ({ body: childCtx.requestId });
        const { "compile": compile } = ctx;
        return compile(child, []);
      `,
    ],
    [
      "a destructuring assignment",
      `
        const child = async (childCtx) => ({ body: childCtx.requestId });
        let compile;
        ({ compile } = ctx);
        return compile(child, []);
      `,
    ],
    [
      "a method passed as a value",
      `
        const child = async (childCtx) => ({ body: childCtx.requestId });
        const invoke = (compile) => compile(child, []);
        return invoke(ctx.compile);
      `,
    ],
    [
      "computed property access",
      `
        const child = async (childCtx) => ({ body: childCtx.requestId });
        return ctx["compile"](child, []);
      `,
    ],
    [
      "template-literal property access",
      `
        const child = async (childCtx) => ({ body: childCtx.requestId });
        return ctx[\`compile\`](child, []);
      `,
    ],
    [
      "an aliased child-context method",
      `
        const leaf = async (leafCtx) => ({ body: leafCtx.requestId });
        const child = async (childCtx) => {
          const compile = childCtx.compile;
          return compile(leaf, []);
        };
        return ctx.compile(child, []);
      `,
    ],
    [
      "a destructured child-context method",
      `
        const leaf = async (leafCtx) => ({ body: leafCtx.requestId });
        const child = async ({ compile }) => compile(leaf, []);
        return ctx.compile(child, []);
      `,
    ],
    [
      "a computed destructured child-context method",
      `
        const leaf = async (leafCtx) => ({ body: leafCtx.requestId });
        const child = async ({ [\`compile\`]: mint }) => mint(leaf, []);
        return ctx.compile(child, []);
      `,
    ],
    [
      "a defaulted destructured child-context method",
      `
        const leaf = async (leafCtx) => ({ body: leafCtx.requestId });
        const child = async ({ compile } = {}) => compile(leaf, []);
        return ctx.compile(child, []);
      `,
    ],
    [
      "an aliased defaulted child context",
      `
        const leaf = async (leafCtx) => ({ body: leafCtx.requestId });
        const child = async (childCtx = {}) => {
          const compile = childCtx.compile;
          return compile(leaf, []);
        };
        return ctx.compile(child, []);
      `,
    ],
  ])("rejects indirect compile access through %s", async (_name, source) => {
    await expect(extractCompileClosures(source)).rejects.toThrow(
      "Call ctx.compile(...) directly; the compile method cannot be aliased, destructured, or passed as a value.",
    );
  });

  it("rejects dynamic and mutable closure references", async () => {
    await expect(
      extractCompileClosures(`return ctx.compile(ctx.params.useA ? a : b, []);`),
    ).rejects.toThrow("requires a function reference");

    await expect(
      extractCompileClosures(`
        let child = async (_childCtx) => ({ body: "ok" });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("must be a top-level const");
  });

  it("rejects reassigned function declarations and shadowed closure bindings", async () => {
    await expect(
      extractCompileClosures(`
        function child(_childCtx) { return { body: "original" }; }
        child = async (_childCtx) => ({ body: "reassigned" });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("unmodified function declaration");

    await expect(
      extractCompileClosures(`
        const child = async (_childCtx) => ({ body: "outer" });
        {
          const child = async (_childCtx) => ({ body: "inner" });
          return ctx.compile(child, []);
        }
      `),
    ).rejects.toThrow("is shadowed");

    await expect(
      extractCompileClosures(`
        const child = async (_childCtx) => ({ body: "outer" });
        const choose = (child) => ctx.compile(child, []);
        return choose(async (_childCtx) => ({ body: "inner" }));
      `),
    ).rejects.toThrow("is shadowed");
  });

  it("requires an explicit child context and rejects the parent context as a capture", async () => {
    await expect(
      extractCompileClosures(`
        const child = async () => ({ body: "old signature" });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("accept the child context as their first parameter");

    await expect(
      extractCompileClosures(`
        const child = async (_childCtx) => ({ body: ctx.params.name });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("cannot capture outer variables: ctx");

    const packagedInline = await extractCompileClosures(`
      const parentValue = "parent";
      return ctx.compile(async (_childCtx) => ({ body: parentValue }), []);
    `);
    expect(packagedInline.closures[0]).toContain('const parentValue = "parent";');

    await expect(
      extractCompileClosures(
        `return ctx.compile(async (_childCtx) => ({ body: ctx.params.name }), []);`,
      ),
    ).rejects.toThrow("cannot capture outer variables: ctx");
  });
});
