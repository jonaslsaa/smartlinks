import { describe, expect, it } from "vitest";
import { extractCompileClosures } from "../../src/cli/compile.js";

describe("compile closure extraction", () => {
  it("extracts named closures and rewrites nested compile references", async () => {
    const extracted = await extractCompileClosures(`
      const leaf = async (name) => ({ body: name });
      const child = async (name) => ctx.compile(leaf, [name]);
      return ctx.compile(child, [ctx.params.name ?? "world"]);
    `);

    expect(extracted.closures).toHaveLength(2);
    expect(extracted.closures[0]).toContain("async (name) => ({ body: name })");
    expect(extracted.closures[1]).toContain("ctx.compile(0, [name])");
    expect(extracted.source).toContain("ctx.compile(1, [ctx.params.name");
  });

  it("accepts inline closures and ordinary object keys", async () => {
    const extracted = await extractCompileClosures(`
      return ctx.compile(async (value) => ({ body: JSON.stringify({ value }) }), ["ok"]);
    `);

    expect(extracted.source).toContain('ctx.compile(0, ["ok"])');
    expect(extracted.closures[0]).toContain("JSON.stringify({ value })");
  });

  it("rejects outer captures that would be unavailable in the child", async () => {
    await expect(
      extractCompileClosures(`
        const prefix = "hello";
        const child = async (name) => ({ body: prefix + name });
        return ctx.compile(child, ["Jonas"]);
      `),
    ).rejects.toThrow("cannot capture outer variables: prefix");
  });

  it("uses lexical scope when a nested function shadows an outer capture", async () => {
    await expect(
      extractCompileClosures(`
        const secret = "outer";
        const child = async () => {
          const nested = (secret) => secret;
          return { body: secret + nested("inner") };
        };
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("cannot capture outer variables: secret");
  });

  it("allows values declared inside the compile closure", async () => {
    const extracted = await extractCompileClosures(`
      const child = async (name) => {
        const greeting = "hello " + name;
        return { body: greeting };
      };
      return ctx.compile(child, ["Jonas"]);
    `);

    expect(extracted.closures[0]).toContain("body: greeting");
  });

  it("ignores compile-like calls on a shadowed context", async () => {
    const extracted = await extractCompileClosures(`
      const invoke = (ctx) => ctx.compile("ordinary method");
      return { body: String(invoke({ compile: (value) => value })) };
    `);

    expect(extracted.closures).toEqual([]);
    expect(extracted.source).toContain('ctx.compile("ordinary method")');
  });

  it("rejects dynamic and mutable closure references", async () => {
    await expect(
      extractCompileClosures(`return ctx.compile(ctx.params.useA ? a : b, []);`),
    ).rejects.toThrow("requires a function reference");

    await expect(
      extractCompileClosures(`
        let child = async () => ({ body: "ok" });
        return ctx.compile(child, []);
      `),
    ).rejects.toThrow("must be declared with const");
  });
});
