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

  it("rejects outer captures that would be unavailable in the child", async () => {
    await expect(
      extractCompileClosures(`
        const prefix = "hello";
        const child = async (_childCtx, name) => ({ body: prefix + name });
        return ctx.compile(child, ["Jonas"]);
      `),
    ).rejects.toThrow("cannot capture outer variables: prefix");
  });

  it("uses lexical scope when a nested function shadows an outer capture", async () => {
    await expect(
      extractCompileClosures(`
        const secret = "outer";
        const child = async (_childCtx) => {
          const nested = (secret) => secret;
          return { body: secret + nested("inner") };
        };
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("cannot capture outer variables: secret");
  });

  it("rejects parent bindings that shadow supported child globals", async () => {
    await expect(
      extractCompileClosures(`
        const Math = { max: () => 123 };
        const fetch = async () => ({ ok: true });
        const child = async (_childCtx) => ({ body: String(Math.max()) + String((await fetch()).ok) });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("cannot capture outer variables: Math, fetch");
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

    await expect(
      extractCompileClosures(`
        const parentValue = "parent";
        return ctx.compile(async (_childCtx) => ({ body: parentValue }), []);
      `),
    ).rejects.toThrow("cannot capture outer variables: parentValue");

    await expect(
      extractCompileClosures(
        `return ctx.compile(async (_childCtx) => ({ body: ctx.params.name }), []);`,
      ),
    ).rejects.toThrow("cannot capture outer variables: ctx");
  });
});
