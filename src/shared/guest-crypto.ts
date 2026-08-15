import { z } from "zod";

const encodingSchema = z.enum(["hex", "base64"]);
export type GuestCryptoEncoding = z.infer<typeof encodingSchema>;
export const MAX_CRYPTO_OPERATIONS = 16;
const MAX_CRYPTO_INPUT_BYTES = 1_048_576;

export type GuestCrypto = {
  sha256(message: string, encoding?: GuestCryptoEncoding): Promise<string>;
  hmacSha256(key: string, message: string, encoding?: GuestCryptoEncoding): Promise<string>;
  verifyHmacSha256(
    key: string,
    message: string,
    signature: string,
    encoding?: GuestCryptoEncoding,
  ): Promise<boolean>;
};

const encoder = new TextEncoder();

function encode(bytes: ArrayBuffer, encoding: GuestCryptoEncoding): string {
  const view = new Uint8Array(bytes);
  if (encoding === "hex") {
    return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decode(value: string, encoding: GuestCryptoEncoding): Uint8Array | undefined {
  if (encoding === "hex") {
    if (!/^(?:[0-9a-fA-F]{2})+$/u.test(value)) {
      return undefined;
    }
    return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function hmacKey(cryptoImpl: Crypto, key: string): Promise<CryptoKey> {
  return cryptoImpl.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function createGuestCrypto(
  cryptoImpl: Crypto = crypto,
  maxOperations = MAX_CRYPTO_OPERATIONS,
): GuestCrypto {
  let operations = 0;
  const guard = (...values: string[]) => {
    operations += 1;
    if (operations > maxOperations) {
      throw new Error(`A script may perform at most ${maxOperations} cryptographic operations.`);
    }
    const bytes = values.reduce((total, value) => total + encoder.encode(value).byteLength, 0);
    if (bytes > MAX_CRYPTO_INPUT_BYTES) {
      throw new Error("Cryptographic input exceeds the 1 MB limit.");
    }
  };

  return {
    async sha256(message, rawEncoding = "hex") {
      guard(message);
      const encoding = encodingSchema.parse(rawEncoding);
      return encode(await cryptoImpl.subtle.digest("SHA-256", encoder.encode(message)), encoding);
    },
    async hmacSha256(key, message, rawEncoding = "hex") {
      guard(key, message);
      const encoding = encodingSchema.parse(rawEncoding);
      const signature = await cryptoImpl.subtle.sign(
        "HMAC",
        await hmacKey(cryptoImpl, key),
        encoder.encode(message),
      );
      return encode(signature, encoding);
    },
    async verifyHmacSha256(key, message, signature, rawEncoding = "hex") {
      guard(key, message, signature);
      const encoding = encodingSchema.parse(rawEncoding);
      const decoded = decode(signature, encoding);
      if (!decoded) {
        return false;
      }
      return cryptoImpl.subtle.verify(
        "HMAC",
        await hmacKey(cryptoImpl, key),
        Uint8Array.from(decoded).buffer,
        encoder.encode(message),
      );
    },
  };
}
