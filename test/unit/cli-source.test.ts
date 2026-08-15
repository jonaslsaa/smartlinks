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

  it("reports TypeScript syntax errors with their source location", async () => {
    await expect(transpileScriptSource("const value: = 1;", "broken.ts")).rejects.toThrow(
      /Could not transpile broken\.ts: 1:\d+: Type expected\./u,
    );
  });

  it("rejects oversized raw TypeScript before erasable syntax can hide it", async () => {
    const source = `type Erased = "${"x".repeat(MAX_SCRIPT_LENGTH)}";\nreturn "ok";`;

    await expect(transpileScriptSource(source, "wrong-file.ts")).rejects.toThrow(
      "1,000,000 character safety limit",
    );
  });
});
