import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { concatBytes, fromBase64Url, text, toBase64Url, utf8 } from "./bytes.js";
import type { DecodedPayload, Envelope, PayloadVersion } from "./codec.js";

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});
const HPKE_INFO = utf8("smartlinks/hpke/v1");

export type PublicKey = {
  keyId: number;
  publicKey: string;
};

export type GeneratedKeyPair = PublicKey & {
  privateKeySecret: string;
};

export type LegacySecretBinding = {
  script: string;
  notAfter?: number;
};

export type ArtifactSecretBinding = {
  authority: 1;
  version: PayloadVersion;
  script: string;
  closures: readonly string[];
  notAfter?: number;
  interstitial: boolean;
  secretName: string;
};

export type SecretBinding = LegacySecretBinding | ArtifactSecretBinding;

export function artifactSecretBinding(
  version: PayloadVersion,
  envelope: Pick<Envelope, "s" | "c" | "i" | "notAfter">,
  secretName: string,
): ArtifactSecretBinding {
  return {
    authority: 1,
    version,
    script: envelope.s,
    closures: envelope.c ?? [],
    ...(envelope.notAfter === undefined ? {} : { notAfter: envelope.notAfter }),
    interstitial: envelope.i === true,
    secretName,
  };
}

function payloadSecretBinding(decoded: DecodedPayload, secretName: string): SecretBinding {
  if (decoded.envelope.a === 1) {
    return artifactSecretBinding(decoded.version, decoded.envelope, secretName);
  }
  if (decoded.envelope.c?.length) {
    throw new Error("Sealed compile closures require complete-artifact binding.");
  }
  return decoded.envelope.notAfter === undefined
    ? { script: decoded.envelope.s }
    : { script: decoded.envelope.s, notAfter: decoded.envelope.notAfter };
}

export function boundSealedSecrets(
  decoded: DecodedPayload,
): Array<{ name: string; blob: string; binding: SecretBinding }> {
  return Object.entries(decoded.envelope.k ?? {}).map(([name, blob]) => ({
    name,
    blob,
    binding: payloadSecretBinding(decoded, name),
  }));
}

function assertKeyId(keyId: number): void {
  if (!Number.isInteger(keyId) || keyId < 1 || keyId > 255) {
    throw new Error("The key ID must be an integer between 1 and 255.");
  }
}

async function aad(keyId: number, binding: SecretBinding): Promise<Uint8Array> {
  if (!("authority" in binding)) {
    const scriptHash = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(utf8(binding.script)).buffer,
    );
    const expiry = binding.notAfter === undefined ? "none" : String(binding.notAfter);
    return concatBytes(
      Uint8Array.of(keyId),
      new Uint8Array(scriptHash),
      utf8(`smartlinks/not-after/${expiry}`),
    );
  }

  const artifact = JSON.stringify([
    binding.version,
    binding.script,
    binding.closures,
    binding.notAfter ?? null,
    binding.interstitial,
    binding.secretName,
  ]);
  const artifactHash = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(utf8(artifact)).buffer,
  );
  return concatBytes(
    Uint8Array.of(keyId),
    utf8("smartlinks/authority/v1"),
    new Uint8Array(artifactHash),
  );
}

export async function generateKeyPair(keyId: number): Promise<GeneratedKeyPair> {
  assertKeyId(keyId);
  const pair = await suite.kem.generateKeyPair();
  const [privateKey, publicKey] = await Promise.all([
    suite.kem.serializePrivateKey(pair.privateKey),
    suite.kem.serializePublicKey(pair.publicKey),
  ]);
  const encodedPublicKey = toBase64Url(publicKey);

  return {
    keyId,
    publicKey: encodedPublicKey,
    privateKeySecret: `${toBase64Url(privateKey)}.${encodedPublicKey}`,
  };
}

export function publicKeyFromPrivateSecret(keyId: number, secret: string): PublicKey {
  assertKeyId(keyId);
  const parts = secret.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`PRIVATE_KEY_${keyId} has an invalid format.`);
  }
  const privateBytes = fromBase64Url(parts[0]);
  const publicBytes = fromBase64Url(parts[1]);
  if (
    privateBytes.byteLength !== suite.kem.privateKeySize ||
    publicBytes.byteLength !== suite.kem.publicKeySize
  ) {
    throw new Error(`PRIVATE_KEY_${keyId} has an invalid key length.`);
  }
  return { keyId, publicKey: parts[1] };
}

export async function sealSecret(
  plaintext: string,
  binding: SecretBinding,
  recipient: PublicKey,
): Promise<string> {
  assertKeyId(recipient.keyId);
  const publicKey = await suite.kem.deserializePublicKey(fromBase64Url(recipient.publicKey));
  const sealed = await suite.seal(
    { recipientPublicKey: publicKey, info: HPKE_INFO },
    utf8(plaintext),
    await aad(recipient.keyId, binding),
  );

  return toBase64Url(
    concatBytes(
      Uint8Array.of(recipient.keyId),
      new Uint8Array(sealed.enc),
      new Uint8Array(sealed.ct),
    ),
  );
}

export function sealedSecretKeyId(blob: string): number {
  const bytes = fromBase64Url(blob);
  const keyId = bytes[0];
  if (keyId === undefined) {
    throw new Error("The sealed secret is empty.");
  }
  return keyId;
}

export async function openSecret(
  blob: string,
  binding: SecretBinding,
  privateSecret: string,
): Promise<string> {
  const bytes = fromBase64Url(blob);
  const keyId = bytes[0];
  if (keyId === undefined) {
    throw new Error("The sealed secret is empty.");
  }
  const encapsulatedEnd = 1 + suite.kem.encSize;
  if (bytes.byteLength <= encapsulatedEnd) {
    throw new Error("The sealed secret is truncated.");
  }

  const [encodedPrivateKey] = privateSecret.split(".");
  if (!encodedPrivateKey) {
    throw new Error(`PRIVATE_KEY_${keyId} has an invalid format.`);
  }
  const privateKey = await suite.kem.deserializePrivateKey(fromBase64Url(encodedPrivateKey));
  const plaintext = await suite.open(
    {
      recipientKey: privateKey,
      enc: bytes.subarray(1, encapsulatedEnd),
      info: HPKE_INFO,
    },
    bytes.subarray(encapsulatedEnd),
    await aad(keyId, binding),
  );
  return text(plaintext);
}
