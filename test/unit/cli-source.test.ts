import { describe, expect, it } from "vitest";
import { transpileScriptSource } from "../../src/cli/source.js";
import { MAX_SCRIPT_LENGTH } from "../../src/shared/codec.js";

describe("CLI script input", () => {
  it("leaves JavaScript input unchanged", async () => {
    const source = 'const value = "js";\nreturn value;';

    await expect(transpileScriptSource(source, "script.js")).resolves.toBe(source);
  });

  it("strips TypeScript syntax based on the file extension", async () => {
    const source = `
      interface Result { body: string }
      const body: string = ctx.params.name ?? "TypeScript";
      return { body } satisfies Result;
    `;

    const transpiled = await transpileScriptSource(source, "script.ts");

    expect(transpiled).toContain("const body =");
    expect(transpiled).toContain("return { body };");
    expect(transpiled).not.toContain("interface Result");
    expect(transpiled).not.toContain("satisfies Result");
  });

  it("type-checks Windows-style input paths", async () => {
    await expect(
      transpileScriptSource(
        'const value: string = "windows";\nreturn value;',
        "C:\\temp\\script.ts",
      ),
    ).resolves.toContain('const value = "windows";');
  });

  it("reports TypeScript syntax errors with their source location", async () => {
    await expect(transpileScriptSource("const value: = 1;", "broken.ts")).rejects.toThrow(
      /Could not transpile broken\.ts: 1:\d+: Type expected\./u,
    );
  });

  it("rejects semantic TypeScript errors by default", async () => {
    await expect(
      transpileScriptSource('const value: number = "wrong";\nreturn value;', "typed.ts"),
    ).rejects.toThrow(
      "Could not type-check typed.ts: 1:7: Type 'string' is not assignable to type 'number'.",
    );

    await expect(
      transpileScriptSource('const echo = (value) => value;\nreturn echo("strict");', "strict.ts"),
    ).rejects.toThrow("Parameter 'value' implicitly has an 'any' type.");
  });

  it("checks the Smartlink context and response contract", async () => {
    await expect(
      transpileScriptSource("return { body: ctx.missing };", "context.ts"),
    ).rejects.toThrow("Property 'missing' does not exist on type '__SmartlinksContext'.");

    await expect(transpileScriptSource("return { body: 123 };", "response.ts")).rejects.toThrow(
      "Type 'number' is not assignable to type 'string'.",
    );

    await expect(
      transpileScriptSource('return await fetch("https://example.com");', "fetch-response.ts"),
    ).rejects.toThrow("Type '__SmartlinksFetchResponse' is not assignable");

    await expect(
      transpileScriptSource(
        'const response = await fetch("https://example.com");\nreturn { body: await response.text() };',
        "mapped-fetch-response.ts",
      ),
    ).resolves.toContain("body: await response.text()");

    await expect(
      transpileScriptSource(
        'const signature = await ctx.crypto.hmacSha256("key", "body");\nreturn { body: ctx.requestId + ":" + ctx.paramValues.tag?.join(",") + ":" + signature };',
        "capabilities.ts",
      ),
    ).resolves.toContain("ctx.crypto.hmacSha256");
  });

  it("allows an omitted return for the default completion page", async () => {
    await expect(
      transpileScriptSource("const name = ctx.params.name;", "no-return.ts"),
    ).resolves.toContain("const name = ctx.params.name;");

    await expect(transpileScriptSource("return 123;", "invalid-return.ts")).rejects.toThrow(
      "Type 'number' is not assignable to type '__SmartlinksResult'.",
    );
  });

  it("type-checks compile closures against their positional argument tuples", async () => {
    await expect(
      transpileScriptSource(
        `
          const child = async (name: string, count: number) => ({ body: name.repeat(count) });
          return ctx.compile(child, ["Jonas", 2], {
            ttlSeconds: 3600,
            interstitial: false,
            seal: { TOKEN: ctx.secrets.TOKEN! },
          });
        `,
        "compile.ts",
      ),
    ).resolves.toContain('ctx.compile(child, ["Jonas", 2]');

    await expect(
      transpileScriptSource(
        `
          const child = async (count: number) => ({ body: String(count) });
          return ctx.compile(child, ["wrong"]);
        `,
        "compile-mismatch.ts",
      ),
    ).rejects.toThrow("Type 'string' is not assignable to type 'number'");

    await expect(
      transpileScriptSource(
        `
          const child = async () => ({ body: 123 });
          return ctx.compile(child, []);
        `,
        "compile-result.ts",
      ),
    ).rejects.toThrow("Type 'number' is not assignable to type 'string'");
  });

  it("can explicitly skip semantic type checking", async () => {
    const transpiled = await transpileScriptSource(
      'const value: number = "runtime";\nreturn value;',
      "unchecked.ts",
      { typeCheck: false },
    );

    expect(transpiled).toContain('const value = "runtime";');
  });

  it("rejects oversized raw TypeScript before erasable syntax can hide it", async () => {
    const source = `type Erased = "${"x".repeat(MAX_SCRIPT_LENGTH)}";\nreturn "ok";`;

    await expect(transpileScriptSource(source, "wrong-file.ts")).rejects.toThrow(
      "1,000,000 character safety limit",
    );
  });
});
