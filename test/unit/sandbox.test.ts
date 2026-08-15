import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "../../src/shared/guarded-fetch.js";
import { runScript, validateScript } from "../../src/shared/sandbox.js";
import { minifyScriptBody } from "../../src/shared/script.js";

const context = {
  params: { name: "Jonas" },
  paramValues: { name: ["Jonas"] },
  method: "GET",
  headers: {},
  body: null,
  secrets: { TOKEN: "secret" },
  requestId: "request-123",
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

  it("provides a guarded Web-like global fetch", async () => {
    const fetchImpl: typeof globalThis.fetch = vi.fn(async () =>
      Response.json({ answer: 42 }, { headers: { "x-test": "yes" } }),
    );
    const fetch = createGuardedFetch({ fetchImpl });

    await expect(
      run(
        `const response = await fetch("https://example.com/data");
         const data = await response.json();
         return { body: [response.ok, response.status, response.url, response.headers.get("x-test"), response.bodyUsed, data.answer].join(":") }`,
        fetch,
      ),
    ).resolves.toEqual({ body: "true:200:https://example.com/data:yes:true:42" });

    await expect(
      run(
        `const response = await fetch("https://example.com/data");
         await response.text();
         await response.text();`,
        fetch,
      ),
    ).rejects.toThrow("Body has already been consumed");
  });

  it("exposes repeated params, request IDs, and native-backed crypto", async () => {
    await expect(
      run(`
        const signature = await ctx.crypto.hmacSha256("key", "message");
        const valid = await ctx.crypto.verifyHmacSha256("key", "message", signature);
        return { body: [ctx.paramValues.name.join(","), ctx.requestId, valid, await ctx.crypto.sha256("hello")].join(":") };
      `),
    ).resolves.toEqual({
      body: "Jonas:request-123:true:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  it("bounds guest cryptographic work", async () => {
    await expect(
      run(
        `await Promise.all(Array.from({ length: 17 }, (_, index) => ctx.crypto.sha256(String(index))))`,
      ),
    ).rejects.toThrow("at most 16 cryptographic operations");
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
      run('await fetch("https://example.com"); return { body: "unreachable" }', neverReturns, 20),
    ).rejects.toThrow("exceeded 20 ms");
  });

  it("compile-checks the exact production wrapper without executing it", async () => {
    const source = await minifyScriptBody('throw new Error("must not execute")');
    await expect(validateScript("2", source)).resolves.toBeUndefined();
    await expect(validateScript("2", "async ctx=>{")).rejects.toThrow("does not compile");
  });
});
