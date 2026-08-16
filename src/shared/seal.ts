import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import type { AuthorCertificate } from "./author.js";
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

type ArtifactIdentityFields = {
  version: PayloadVersion;
  script: string;
  closures: readonly string[];
  notAfter?: number;
  interstitial: boolean;
  interstitialNote?: string;
};

type ArtifactSecretFields = ArtifactIdentityFields & {
  secretName: string;
};

export type ArtifactSecretBinding =
  | (ArtifactSecretFields & { authority: 1; authorCertificate?: never })
  | (ArtifactSecretFields & { authority: 2; authorCertificate: AuthorCertificate });

export type SecretBinding = LegacySecretBinding | ArtifactSecretBinding;

export type ArtifactIdentity = ArtifactIdentityFields;

function artifactIdentityValues(identity: ArtifactIdentity): readonly unknown[] {
  const values = [
    identity.version,
    identity.script,
    identity.closures,
    identity.notAfter ?? null,
    identity.interstitial,
  ];
  return identity.interstitialNote === undefined ? values : [...values, identity.interstitialNote];
}

function compareSealedSecretEntries(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  if (left[0] < right[0]) {
    return -1;
  }
  if (left[0] > right[0]) {
    return 1;
  }
  return 0;
}

export function payloadArtifactIdentity(
  decoded: Pick<DecodedPayload, "version" | "envelope">,
): string {
  const identity = artifactIdentityValues({
    version: decoded.version,
    script: decoded.envelope.s,
    closures: decoded.envelope.c ?? [],
    ...(decoded.envelope.notAfter === undefined ? {} : { notAfter: decoded.envelope.notAfter }),
    interstitial: decoded.envelope.i === true,
    ...(decoded.envelope.interstitialNote === undefined
      ? {}
      : { interstitialNote: decoded.envelope.interstitialNote }),
  });
  const sealedSecrets = Object.entries(decoded.envelope.k ?? {}).sort(compareSealedSecretEntries);
  return JSON.stringify([...identity, decoded.envelope.a ?? null, sealedSecrets]);
}

export function artifactSecretBinding(
  version: PayloadVersion,
  envelope: Pick<Envelope, "s" | "c" | "i" | "a" | "notAfter" | "interstitialNote">,
  secretName: string,
  authorCertificate?: AuthorCertificate,
): ArtifactSecretBinding {
  const signedAuthority = envelope.a === 2;
  if (signedAuthority !== (authorCertificate !== undefined)) {
    throw new Error("Signed sealed secrets require their author certificate.");
  }
  const fields: ArtifactSecretFields = {
    version,
    script: envelope.s,
    closures: envelope.c ?? [],
    ...(envelope.notAfter === undefined ? {} : { notAfter: envelope.notAfter }),
    interstitial: envelope.i === true,
    ...(envelope.interstitialNote === undefined
      ? {}
      : { interstitialNote: envelope.interstitialNote }),
    secretName,
  };
  return authorCertificate === undefined
    ? { ...fields, authority: 1 }
    : { ...fields, authority: 2, authorCertificate };
}

function payloadSecretBinding(decoded: DecodedPayload, secretName: string): SecretBinding {
  if (decoded.envelope.a === 1 || decoded.envelope.a === 2) {
    return artifactSecretBinding(
      decoded.version,
      decoded.envelope,
      secretName,
      decoded.envelope.a === 2 ? decoded.envelope.u?.[0] : undefined,
    );
  }
  if (decoded.envelope.c?.length) {
    throw new Error("Sealed compile closures require complete-artifact binding.");
  }
  if (decoded.envelope.interstitialNote !== undefined) {
    throw new Error("Sealed interstitial notes require complete-artifact binding.");
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

  const artifactFields = [...artifactIdentityValues(binding), binding.secretName];
  const artifact = JSON.stringify(
    binding.authority === 1
      ? artifactFields
      : [binding.authority, ...artifactFields, binding.authorCertificate],
  );
  const artifactHash = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(utf8(artifact)).buffer,
  );
  return concatBytes(
    Uint8Array.of(keyId),
    utf8(`smartlinks/authority/v${binding.authority}`),
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
