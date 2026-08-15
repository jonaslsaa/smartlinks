import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  openSecret,
  publicKeyFromPrivateSecret,
  sealedSecretKeyId,
  sealSecret,
} from "../../src/shared/seal.js";

describe("sealed secrets", () => {
  it("round-trips with the matching script and key", async () => {
    const pair = await generateKeyPair(7);
    const binding = { script: "async()=>42" };
    const blob = await sealSecret("top secret", binding, pair);

    expect(sealedSecretKeyId(blob)).toBe(7);
    await expect(openSecret(blob, binding, pair.privateKeySecret)).resolves.toBe("top secret");
    expect(publicKeyFromPrivateSecret(7, pair.privateKeySecret)).toEqual({
      keyId: 7,
      publicKey: pair.publicKey,
    });
  });

  it("refuses to decrypt a blob moved to another script", async () => {
    const pair = await generateKeyPair(1);
    const blob = await sealSecret("top secret", { script: "async()=>1" }, pair);

    await expect(
      openSecret(blob, { script: "async()=>2" }, pair.privateKeySecret),
    ).rejects.toThrow();
  });

  it("binds the exact expiry or explicit no-expiry state", async () => {
    const pair = await generateKeyPair(1);
    const binding = { script: "async()=>1", notAfter: 2_000_000_000 };
    const blob = await sealSecret("top secret", binding, pair);

    await expect(openSecret(blob, binding, pair.privateKeySecret)).resolves.toBe("top secret");
    await expect(
      openSecret(blob, { script: binding.script }, pair.privateKeySecret),
    ).rejects.toThrow();
    await expect(
      openSecret(
        blob,
        { script: binding.script, notAfter: binding.notAfter + 1 },
        pair.privateKeySecret,
      ),
    ).rejects.toThrow();
  });

  it("validates the one-byte rotation key ID", async () => {
    await expect(generateKeyPair(0)).rejects.toThrow("between 1 and 255");
    await expect(generateKeyPair(256)).rejects.toThrow("between 1 and 255");
  });
});
