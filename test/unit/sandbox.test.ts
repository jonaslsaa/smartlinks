import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "../../src/shared/guarded-fetch.js";
import { runScript, validateScript } from "../../src/shared/sandbox.js";
import { minifyScriptBody } from "../../src/shared/script.js";

const context = {
  params: { name: "Jonas" },
  method: "GET",
  headers: {},
  body: null,
  secrets: { TOKEN: "secret" },
};

async function run(body: string, fetch = createGuardedFetch(), timeoutMs?: number) {
  return runScript({
    version: "2",
    source: await minifyScriptBody(body),
    context,
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("QuickJS sandbox", () => {
  it("passes plain context and returns plain response values", async () => {
    await expect(
      run(`return { status: 201, body: \`\${ctx.params.name}:\${ctx.secrets.TOKEN}\` }`),
    ).resolves.toEqual({ status: 201, body: "Jonas:secret" });
  });

  it("does not expose host globals", async () => {
    await expect(
      run('return { body: [typeof process, typeof require, typeof Buffer].join(",") }'),
    ).resolves.toEqual({ body: "undefined,undefined,undefined" });
  });

  it("bridges guarded async fetches", async () => {
    const fetchImpl: typeof globalThis.fetch = vi.fn(async () =>
      Response.json({ answer: 42 }, { headers: { "x-test": "yes" } }),
    );
    const fetch = createGuardedFetch({ fetchImpl });

    await expect(
      run(
        `const response = await ctx.fetch("https://example.com"); return { body: \`\${response.status}:\${response.text}\` }`,
        fetch,
      ),
    ).resolves.toEqual({ body: '200:{"answer":42}' });
  });

  it("interrupts runaway synchronous code", async () => {
    await expect(run("while (true) {}")).rejects.toThrow();
  });

  it("rejects guest promises that cannot make progress", async () => {
    await expect(run("await new Promise(() => {})")).rejects.toThrow("cannot make progress");
  });

  it("enforces an overall deadline while waiting for host calls", async () => {
    const neverReturns = () => new Promise<never>(() => undefined);
    await expect(
      run(
        'await ctx.fetch("https://example.com"); return { body: "unreachable" }',
        neverReturns,
        20,
      ),
    ).rejects.toThrow("exceeded 20 ms");
  });

  it("compile-checks the exact production wrapper without executing it", async () => {
    const source = await minifyScriptBody('throw new Error("must not execute")');
    await expect(validateScript("2", source)).resolves.toBeUndefined();
    await expect(validateScript("2", "async ctx=>{")).rejects.toThrow("does not compile");
  });
});
