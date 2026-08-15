import { describe, expect, it, vi } from "vitest";
import { encodePayload } from "../../src/shared/codec.js";
import { createCryptoOperationBudget } from "../../src/shared/guest-crypto.js";
import { createSmartlinkCompiler } from "../../src/shared/mint.js";
import { generateKeyPair } from "../../src/shared/seal.js";

async function compiler(overrides: Partial<Parameters<typeof createSmartlinkCompiler>[0]> = {}) {
  const pair = await generateKeyPair(1);
  return createSmartlinkCompiler({
    parent: {
      version: "2",
      envelope: {
        s: "async ctx=>ctx.compile(0,[])",
        c: ["async value=>({body:String(value)})"],
      },
    },
    parentSecrets: {},
    service: "https://runtime.example/",
    getPublicKey: () => pair,
    encode: async (envelope, version) => encodePayload(envelope, version),
    validate: vi.fn(async () => undefined),
    cryptoBudget: createCryptoOperationBudget(),
    nowSeconds: () => 1_000,
    ...overrides,
  });
}

describe("smartlink minting", () => {
  it("canonicalizes tuple arguments and clamps expiry to the parent", async () => {
    const encode = vi.fn(async (envelope, version) => encodePayload(envelope, version));
    const compile = await compiler({
      parent: {
        version: "2",
        envelope: {
          s: "async ctx=>ctx.compile(0,[])",
          c: ["async value=>({body:JSON.stringify(value)})"],
          i: true,
          notAfter: 1_100,
        },
      },
      encode,
    });

    await compile(0, [{ z: 1, a: 2 }], { ttlSeconds: 500, interstitial: false });
    const envelope = encode.mock.calls[0]?.[0];

    expect(envelope?.notAfter).toBe(1_100);
    expect(envelope?.i).toBeUndefined();
    expect(envelope?.s).toContain('{\\"a\\":2,\\"z\\":1}');
  });

  it("inherits parent expiry and interstitial when options are omitted", async () => {
    const encode = vi.fn(async (envelope, version) => encodePayload(envelope, version));
    const compile = await compiler({
      parent: {
        version: "2",
        envelope: {
          s: "async ctx=>ctx.compile(0,[])",
          c: ["async()=>({body:'ok'})"],
          i: true,
          notAfter: 2_000,
        },
      },
      encode,
    });

    await compile(0, [], undefined);
    expect(encode.mock.calls[0]?.[0]).toMatchObject({ i: true, notAfter: 2_000 });
  });

  it("lets children opt into their own note without inheriting the parent's note", async () => {
    const encode = vi.fn(async (envelope, version) => encodePayload(envelope, version));
    const compile = await compiler({
      parent: {
        version: "2",
        envelope: {
          s: "async ctx=>ctx.compile(0,[])",
          c: ["async()=>({body:'ok'})"],
          i: true,
          interstitialNote: "Parent note",
        },
      },
      encode,
    });

    await compile(0, [], undefined);
    expect(encode.mock.calls[0]?.[0]).toMatchObject({ i: true });
    expect(encode.mock.calls[0]?.[0].interstitialNote).toBeUndefined();

    await compile(0, [], { note: "  Child\n note  " });
    expect(encode.mock.calls[1]?.[0]).toMatchObject({
      i: true,
      interstitialNote: "Child note",
    });
    await expect(compile(0, [], { note: "No", interstitial: false })).rejects.toThrow(
      "note cannot be used with interstitial: false",
    );
  });

  it("rejects plaintext parent secrets in args but permits explicit sealing", async () => {
    const compile = await compiler({ parentSecrets: { TOKEN: "sensitive-value" } });

    await expect(compile(0, ["sensitive-value"], undefined)).rejects.toThrow(
      "Pass it through options.seal",
    );
    await expect(
      compile(0, ["safe"], { seal: { CHILD_TOKEN: "sensitive-value" } }),
    ).resolves.toMatch(/^https:\/\/runtime\.example\/r\/2/u);
  });

  it("rejects escaped parent-secret bytes in tuple values and object keys", async () => {
    const secret = 'quote"slash\\line\nseparator\u2028';
    const compile = await compiler({ parentSecrets: { TOKEN: secret } });

    await expect(compile(0, [{ value: secret }], undefined)).rejects.toThrow(
      "Pass it through options.seal",
    );
    await expect(compile(0, [{ [secret]: "value" }], undefined)).rejects.toThrow(
      "Pass it through options.seal",
    );
  });

  it("rejects non-JSON tuples, prototype keys, and oversized argument data", async () => {
    const compile = await compiler();

    await expect(compile(0, { value: 1 }, undefined)).rejects.toThrow("argument tuple");
    await expect(compile(0, [JSON.parse('{"__proto__":"bad"}')], undefined)).rejects.toThrow(
      "__proto__",
    );
    await expect(compile(0, ["x".repeat(65_000)], undefined)).rejects.toThrow("64 KB");
    await expect(compile(0, [], { ttlSeconds: 0 })).rejects.toThrow(
      "Invalid ctx.compile option ttlSeconds",
    );
  });

  it("charges sealed values to the shared crypto-operation budget", async () => {
    const compile = await compiler({ cryptoBudget: createCryptoOperationBudget(1) });

    await expect(compile(0, [], { seal: { TOKEN_A: "a", TOKEN_B: "b" } })).rejects.toThrow(
      "at most 1 cryptographic operations",
    );
  });
});
