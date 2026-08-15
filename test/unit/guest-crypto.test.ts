import { describe, expect, it, vi } from "vitest";
import {
  createCryptoOperationBudget,
  createGuestCrypto,
  MAX_RANDOM_BYTES,
} from "../../src/shared/guest-crypto.js";

describe("guest cryptographic primitives", () => {
  it("encodes injected random bytes as lowercase hex or padded Base64", async () => {
    let nextByte = 0;
    const randomBytes = vi.fn((byteCount: number) =>
      Uint8Array.from({ length: byteCount }, () => nextByte++),
    );
    const guest = createGuestCrypto({
      crypto,
      budget: createCryptoOperationBudget(),
      randomBytes,
    });

    await expect(guest.random(4)).resolves.toBe("00010203");
    await expect(guest.random(3, "base64")).resolves.toBe("BAUG");
    expect(randomBytes).toHaveBeenNthCalledWith(1, 4);
    expect(randomBytes).toHaveBeenNthCalledWith(2, 3);
  });

  it("validates random byte counts and the runtime byte source", async () => {
    for (const byteCount of [0, -1, 1.5]) {
      await expect(createGuestCrypto().random(byteCount)).rejects.toThrow("positive integer");
    }
    await expect(createGuestCrypto().random(MAX_RANDOM_BYTES + 1)).rejects.toThrow(
      `at most ${MAX_RANDOM_BYTES} bytes`,
    );
    await expect(
      createGuestCrypto({
        crypto,
        budget: createCryptoOperationBudget(),
        randomBytes: () => new Uint8Array(),
      }).random(1),
    ).rejects.toThrow("invalid number of random bytes");

    await expect(createGuestCrypto().random(1, "base64url" as never)).rejects.toThrow(
      'Encoding must be "hex" or "base64".',
    );
    await expect(createGuestCrypto().sha256("message", "base64url" as never)).rejects.toThrow(
      'Encoding must be "hex" or "base64".',
    );
  });

  it("keeps injected random bytes separate from token nonces", async () => {
    let nonceByte = 1;
    const nonceCalls: number[] = [];
    const cryptoImpl = {
      subtle: crypto.subtle,
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        nonceCalls.push(array.byteLength);
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(nonceByte++);
        return array;
      },
      randomUUID: () => crypto.randomUUID(),
    } satisfies Crypto;
    const injectedRandom = vi.fn((byteCount: number) => new Uint8Array(byteCount).fill(255));
    const guest = createGuestCrypto({
      crypto: cryptoImpl,
      budget: createCryptoOperationBudget(),
      randomBytes: injectedRandom,
    });

    await expect(guest.random(4)).resolves.toBe("ffffffff");
    expect(injectedRandom).toHaveBeenCalledOnce();
    injectedRandom.mockClear();

    const first = await guest.seal("state", { key: "0123456789abcdef" });
    const second = await guest.seal("state", { key: "0123456789abcdef" });

    expect(injectedRandom).not.toHaveBeenCalled();
    expect(nonceCalls).toEqual([12, 12]);
    expect(second).not.toBe(first);
  });

  it("shares the existing cryptographic operation budget", async () => {
    const guest = createGuestCrypto({ crypto, budget: createCryptoOperationBudget(2) });

    await expect(guest.random(1)).resolves.toMatch(/^[0-9a-f]{2}$/u);
    await expect(guest.sha256("message")).resolves.toMatch(/^[0-9a-f]{64}$/u);
    await expect(guest.random(1)).rejects.toThrow("at most 2 cryptographic operations");
  });
});
