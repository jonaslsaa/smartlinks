import { z } from "zod";
import { concatBytes, fromBase64Url, text, toBase64Url, utf8 } from "./bytes.js";

const encodingSchema = z.enum(["hex", "base64"]);
export type GuestCryptoEncoding = z.infer<typeof encodingSchema>;
export const MAX_CRYPTO_OPERATIONS = 16;
export const MAX_RANDOM_BYTES = 256;
const MAX_CRYPTO_INPUT_BYTES = 1_048_576;
export const MIN_TOKEN_KEY_BYTES = 16;
const TOKEN_VERSION = 1;
const TOKEN_NONCE_BYTES = 12;
const TOKEN_TAG_BYTES = 16;
const TRANSPARENT_KEY_INFO = "smartlinks/guest-aead/v1";
const EXPLICIT_KEY_INFO = "smartlinks/guest-aead/explicit/v1";

const tokenOptionsSchema = z
  .strictObject({
    key: z.string().optional(),
    context: z.string().optional(),
  })
  .optional();
export type GuestTokenOptions = z.infer<typeof tokenOptionsSchema>;

export type GuestTokenKeySource = {
  masterSecret: string | undefined;
  artifactIdentity: string;
};

export type GuestCrypto = {
  random(byteCount: number, encoding?: GuestCryptoEncoding): Promise<string>;
  sha256(message: string, encoding?: GuestCryptoEncoding): Promise<string>;
  hmacSha256(key: string, message: string, encoding?: GuestCryptoEncoding): Promise<string>;
  verifyHmacSha256(
    key: string,
    message: string,
    signature: string,
    encoding?: GuestCryptoEncoding,
  ): Promise<boolean>;
  seal(value: unknown, options?: GuestTokenOptions): Promise<string>;
  open(token: string, options?: GuestTokenOptions): Promise<unknown>;
};

export type CryptoOperationBudget = {
  consume(count?: number): void;
};

export type GuestRandomBytes = (byteCount: number) => Uint8Array;

const encoder = new TextEncoder();

function parseEncoding(value: unknown): GuestCryptoEncoding {
  const parsed = encodingSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError('Encoding must be "hex" or "base64".');
  }
  return parsed.data;
}

function encode(bytes: ArrayBuffer | Uint8Array, encoding: GuestCryptoEncoding): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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

export function createCryptoOperationBudget(
  maxOperations = MAX_CRYPTO_OPERATIONS,
): CryptoOperationBudget {
  let operations = 0;
  return {
    consume(count = 1) {
      operations += count;
      if (operations > maxOperations) {
        throw new Error(`A script may perform at most ${maxOperations} cryptographic operations.`);
      }
    },
  };
}

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function deriveTokenKey(
  cryptoImpl: Crypto,
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const material = await cryptoImpl.subtle.importKey("raw", bufferSource(ikm), "HKDF", false, [
    "deriveKey",
  ]);
  return cryptoImpl.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bufferSource(salt), info: bufferSource(utf8(info)) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// The token version byte is unauthenticated; a future token version must also change this
// AAD string.
function tokenAad(context: string | undefined): Uint8Array<ArrayBuffer> {
  return bufferSource(utf8(`smartlinks/guest-token/v1 ${context ?? ""}`));
}

function parseTokenOptions(rawOptions: unknown): GuestTokenOptions {
  if (
    rawOptions !== null &&
    typeof rawOptions === "object" &&
    "key" in rawOptions &&
    rawOptions.key === undefined
  ) {
    throw new Error(
      'The token key is undefined. Pass a string of at least 16 bytes or omit "key".',
    );
  }
  const parsed = tokenOptionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid token options: ${detail}`);
  }
  return parsed.data;
}

export function createGuestCrypto(
  cryptoImpl: Crypto = crypto,
  budget: CryptoOperationBudget = createCryptoOperationBudget(),
  tokenKeySource?: GuestTokenKeySource,
  randomBytes: GuestRandomBytes = (byteCount) =>
    cryptoImpl.getRandomValues(new Uint8Array(byteCount)),
): GuestCrypto {
  const guard = (...values: string[]) => {
    budget.consume();
    const bytes = values.reduce((total, value) => total + encoder.encode(value).byteLength, 0);
    if (bytes > MAX_CRYPTO_INPUT_BYTES) {
      throw new Error("Cryptographic input exceeds the 1 MB limit.");
    }
  };

  let transparentKey: Promise<CryptoKey> | undefined;
  const tokenKey = async (options: GuestTokenOptions): Promise<CryptoKey> => {
    if (options?.key !== undefined) {
      const keyBytes = encoder.encode(options.key);
      if (keyBytes.byteLength < MIN_TOKEN_KEY_BYTES) {
        throw new Error(`A token key must be at least ${MIN_TOKEN_KEY_BYTES} bytes.`);
      }
      return deriveTokenKey(cryptoImpl, keyBytes, new Uint8Array(0), EXPLICIT_KEY_INFO);
    }
    if (tokenKeySource?.masterSecret === undefined) {
      throw new Error(
        "The transparent token key is not configured in this runtime. Set the TOKEN_MASTER_SECRET Worker secret, or pass an explicit key.",
      );
    }
    const { masterSecret, artifactIdentity } = tokenKeySource;
    transparentKey ??= (async () =>
      deriveTokenKey(
        cryptoImpl,
        encoder.encode(masterSecret),
        new Uint8Array(
          await cryptoImpl.subtle.digest("SHA-256", bufferSource(utf8(artifactIdentity))),
        ),
        TRANSPARENT_KEY_INFO,
      ))();
    return transparentKey;
  };

  return {
    async random(byteCount, rawEncoding = "hex") {
      budget.consume();
      if (!Number.isInteger(byteCount) || byteCount <= 0) {
        throw new TypeError("random requires a positive integer byte count.");
      }
      if (byteCount > MAX_RANDOM_BYTES) {
        throw new Error(`random may generate at most ${MAX_RANDOM_BYTES} bytes.`);
      }
      const encoding = parseEncoding(rawEncoding);
      const bytes = randomBytes(byteCount);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteCount) {
        throw new Error("The runtime returned an invalid number of random bytes.");
      }
      return encode(bytes, encoding);
    },
    async sha256(message, rawEncoding = "hex") {
      guard(message);
      const encoding = parseEncoding(rawEncoding);
      return encode(await cryptoImpl.subtle.digest("SHA-256", encoder.encode(message)), encoding);
    },
    async hmacSha256(key, message, rawEncoding = "hex") {
      guard(key, message);
      const encoding = parseEncoding(rawEncoding);
      const signature = await cryptoImpl.subtle.sign(
        "HMAC",
        await hmacKey(cryptoImpl, key),
        encoder.encode(message),
      );
      return encode(signature, encoding);
    },
    async verifyHmacSha256(key, message, signature, rawEncoding = "hex") {
      guard(key, message, signature);
      const encoding = parseEncoding(rawEncoding);
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
    async seal(value, rawOptions) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new TypeError("seal requires a JSON-serializable value.");
      }
      const options = parseTokenOptions(rawOptions);
      guard(serialized, options?.key ?? "", options?.context ?? "");
      const key = await tokenKey(options);
      const nonce = cryptoImpl.getRandomValues(new Uint8Array(TOKEN_NONCE_BYTES));
      const ciphertext = await cryptoImpl.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: tokenAad(options?.context) },
        key,
        bufferSource(utf8(serialized)),
      );
      return toBase64Url(
        concatBytes(Uint8Array.of(TOKEN_VERSION), nonce, new Uint8Array(ciphertext)),
      );
    },
    async open(token, rawOptions) {
      if (typeof token !== "string") {
        throw new TypeError("open requires a token string.");
      }
      const options = parseTokenOptions(rawOptions);
      guard(token, options?.key ?? "", options?.context ?? "");
      let bytes: Uint8Array;
      try {
        bytes = fromBase64Url(token);
      } catch {
        throw new Error("The token is not a valid base64url value.");
      }
      const ciphertextStart = 1 + TOKEN_NONCE_BYTES;
      if (bytes.byteLength < ciphertextStart + TOKEN_TAG_BYTES) {
        throw new Error("The token is truncated.");
      }
      if (bytes[0] !== TOKEN_VERSION) {
        throw new Error("The token has an unsupported version.");
      }
      const key = await tokenKey(options);
      let plaintext: ArrayBuffer;
      try {
        plaintext = await cryptoImpl.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bufferSource(bytes.subarray(1, ciphertextStart)),
            additionalData: tokenAad(options?.context),
          },
          key,
          bufferSource(bytes.subarray(ciphertextStart)),
        );
      } catch {
        throw new Error(
          "The token could not be opened. It was tampered with, sealed by a different link, or sealed with a different key or context.",
        );
      }
      return JSON.parse(text(plaintext)) as unknown;
    },
  };
}
