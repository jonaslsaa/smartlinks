import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "../../src/shared/guarded-fetch.js";
import { createCryptoOperationBudget, createGuestCrypto } from "../../src/shared/guest-crypto.js";
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

  it("provides browser-compatible Latin-1 base64 globals", async () => {
    await expect(
      run(`
        const encode = btoa;
        const decode = atob;
        String.fromCharCode = () => "tampered";
        String.prototype.charCodeAt = () => 0;
        String.prototype.indexOf = () => -1;
        let encodeError = "";
        let decodeError = "";
        let omittedEncodeError = "";
        let omittedDecodeError = "";
        let symbolEncodeError = "";
        let symbolDecodeError = "";
        try { encode("€"); } catch (error) { encodeError = error.name; }
        try { decode("not base64!"); } catch (error) { decodeError = error.name; }
        try { encode(); } catch (error) { omittedEncodeError = error.name; }
        try { decode(); } catch (error) { omittedDecodeError = error.name; }
        try { encode(Symbol("value")); } catch (error) { symbolEncodeError = error.name; }
        try { decode(Symbol("value")); } catch (error) { symbolDecodeError = error.name; }
        return {
          body: JSON.stringify({
            names: [encode.name, decode.name],
            encoded: encode("hello"),
            binary: encode("\\x00\\xff"),
            decoded: decode("aGVsbG8"),
            whitespace: decode("Y Q=="),
            permissiveBits: decode("AB==").charCodeAt(0),
            encodeError,
            decodeError,
            omittedEncodeError,
            omittedDecodeError,
            symbolEncodeError,
            symbolDecodeError,
          }),
        };
      `),
    ).resolves.toEqual({
      body: JSON.stringify({
        names: ["btoa", "atob"],
        encoded: "aGVsbG8=",
        binary: "AP8=",
        decoded: "hello",
        whitespace: "a",
        permissiveBits: 0,
        encodeError: "InvalidCharacterError",
        decodeError: "InvalidCharacterError",
        omittedEncodeError: "TypeError",
        omittedDecodeError: "TypeError",
        symbolEncodeError: "TypeError",
        symbolDecodeError: "TypeError",
      }),
    });
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

  it("bridges host entropy into the shared crypto budget", async () => {
    let nextByte = 0;
    const cryptoBudget = createCryptoOperationBudget();
    await expect(
      runScript({
        version: "2",
        source: await minifyScriptBody(`
          const first = await ctx.crypto.random(4);
          const second = await ctx.crypto.random(3, "base64");
          return { body: first + ":" + second };
        `),
        context,
        fetch: createGuardedFetch(),
        crypto: createGuestCrypto({
          crypto,
          budget: cryptoBudget,
          randomBytes: (byteCount) => Uint8Array.from({ length: byteCount }, () => nextByte++),
        }),
        cryptoBudget,
      }),
    ).resolves.toEqual({ body: "00010203:BAUG" });
  });

  it("reports invalid crypto encodings as API errors", async () => {
    await expect(run(`await ctx.crypto.random(1, "base64url")`)).rejects.toThrow(
      'Encoding must be "hex" or "base64".',
    );
  });

  it("bounds guest cryptographic work", async () => {
    await expect(
      run(
        `await Promise.all(Array.from({ length: 17 }, (_, index) => ctx.crypto.sha256(String(index))))`,
      ),
    ).rejects.toThrow("at most 16 cryptographic operations");
  });

  it("seals and opens tokens inside the sandbox", async () => {
    const cryptoBudget = createCryptoOperationBudget();
    await expect(
      runScript({
        version: "2",
        source: await minifyScriptBody(`
          const token = await ctx.crypto.seal({ step: 2, list: [1, "two"] }, { context: "wizard" });
          const state = await ctx.crypto.open(token, { context: "wizard" });
          const voucher = await ctx.crypto.seal("prize", { key: "0123456789abcdef" });
          const claim = await ctx.crypto.open(voucher, { key: "0123456789abcdef" });
          return { body: [state.step, state.list.join("-"), claim].join(":") };
        `),
        context,
        fetch: createGuardedFetch(),
        crypto: createGuestCrypto({
          crypto,
          budget: cryptoBudget,
          tokenKeySource: {
            masterSecret: "sandbox-master",
            artifactIdentity: "sandbox-artifact",
          },
        }),
        cryptoBudget,
      }),
    ).resolves.toEqual({ body: "2:1-two:prize" });
  });

  it("reports missing transparent key configuration to the script", async () => {
    await expect(run(`return { body: await ctx.crypto.seal("state") }`)).rejects.toThrow(
      "transparent token key is not configured",
    );
  });

  it("rejects non-JSON seal values and undefined keys at the guest bridge", async () => {
    await expect(run(`await ctx.crypto.seal(() => 1)`)).rejects.toThrow("JSON-serializable");
    await expect(run(`await ctx.crypto.seal(1, { key: undefined })`)).rejects.toThrow('omit "key"');
  });

  it("allows only one compile attempt, including after a rejected first attempt", async () => {
    const compile = vi.fn(async () => {
      throw new Error("first compile rejected");
    });
    await expect(
      runScript({
        version: "2",
        source: await minifyScriptBody(`
          try { await ctx.compile(0, []); } catch {}
          return ctx.compile(0, []);
        `),
        context,
        fetch: createGuardedFetch(),
        compile,
      }),
    ).rejects.toThrow("at most once per execution");
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-finite numbers", "[NaN]", "finite numbers"],
    ["undefined", "[undefined]", "JSON-serializable"],
    ["functions", "[() => 1]", "JSON-serializable"],
    ["symbols", "[Symbol('value')]", "JSON-serializable"],
    ["nested undefined", "[{ value: undefined }]", "JSON-serializable"],
  ])("rejects %s before QuickJS can coerce compile args", async (_name, args, message) => {
    const compile = vi.fn(async () => "https://smartlinks.local/r/unused");

    await expect(
      runScript({
        version: "2",
        source: await minifyScriptBody(`return ctx.compile(0, ${args});`),
        context,
        fetch: createGuardedFetch(),
        compile,
      }),
    ).rejects.toThrow(message);
    expect(compile).not.toHaveBeenCalled();
  });

  it("charges the compile attempt before guest argument validation", async () => {
    const compile = vi.fn(async () => "https://smartlinks.local/r/unused");

    await expect(
      runScript({
        version: "2",
        source: await minifyScriptBody(`
          try { await ctx.compile(0, [NaN]); } catch {}
          return ctx.compile(0, []);
        `),
        context,
        fetch: createGuardedFetch(),
        compile,
      }),
    ).rejects.toThrow("at most once per execution");
    expect(compile).not.toHaveBeenCalled();
  });

  it("serializes an intrinsic-safe snapshot of compile arguments", async () => {
    const compile = vi.fn(async () => "https://example.com/compiled");

    await expect(
      runScript({
        version: "2",
        source: await minifyScriptBody(`
          const value = {};
          Object.defineProperty(value, "a", {
            enumerable: true,
            get() {
              value.injected = NaN;
              return "snapshot";
            },
          });
          Number.isFinite = () => true;
          JSON.stringify = () => "tampered";
          Reflect.ownKeys = () => [];
          Array.prototype[Symbol.iterator] = function* () {};
          return ctx.compile(0, [value]);
        `),
        context,
        fetch: createGuardedFetch(),
        compile,
      }),
    ).resolves.toBe("https://example.com/compiled");
    expect(compile).toHaveBeenCalledWith(0, [{ a: "snapshot" }], undefined);
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
