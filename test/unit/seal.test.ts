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
    const blob = await sealSecret("top secret", "async()=>42", pair);

    expect(sealedSecretKeyId(blob)).toBe(7);
    await expect(openSecret(blob, "async()=>42", pair.privateKeySecret)).resolves.toBe(
      "top secret",
    );
    expect(publicKeyFromPrivateSecret(7, pair.privateKeySecret)).toEqual({
      keyId: 7,
      publicKey: pair.publicKey,
    });
  });

  it("refuses to decrypt a blob moved to another script", async () => {
    const pair = await generateKeyPair(1);
    const blob = await sealSecret("top secret", "async()=>1", pair);

    await expect(openSecret(blob, "async()=>2", pair.privateKeySecret)).rejects.toThrow();
  });

  it("validates the one-byte rotation key ID", async () => {
    await expect(generateKeyPair(0)).rejects.toThrow("between 1 and 255");
    await expect(generateKeyPair(256)).rejects.toThrow("between 1 and 255");
  });
});
