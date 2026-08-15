import { z } from "zod";
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from "./bytes.js";
import type { DecodedPayload, Envelope, PayloadVersion } from "./codec.js";

const GITHUB_LOGIN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const CERTIFICATE_DOMAIN = utf8("smartlinks/author-certificate/v1\0");
const ARTIFACT_DOMAIN = utf8("smartlinks/author-artifact/v1\0");
const KEY_CHECK_DOMAIN = utf8("smartlinks/author-key-check/v1\0");

export const GITHUB_APP_CLIENT_ID = "Iv23liVE6og0SQZEQqSc";

const encodedPublicKeySchema = z
  .string()
  .length(43, "The author public key is invalid.")
  .regex(BASE64URL, "The author public key is invalid.");

const encodedSignatureSchema = z
  .string()
  .length(86, "The author signature is invalid.")
  .regex(BASE64URL, "The author signature is invalid.");

export const authorCertificateSchema = z
  .tuple([
    z.literal(1),
    z.number().int().min(1).max(255),
    z.number().int().positive().safe(),
    z.string().regex(GITHUB_LOGIN),
    encodedPublicKeySchema,
    z.number().int().positive().safe(),
    z.number().int().positive().safe(),
    encodedSignatureSchema,
  ])
  .refine((certificate) => certificate[6] > certificate[5], {
    message: "The author certificate expiry must follow its issue time.",
  });

export const authorProofSchema = z.tuple([authorCertificateSchema, encodedSignatureSchema]);

export type AuthorCertificate = z.infer<typeof authorCertificateSchema>;
export type AuthorProof = z.infer<typeof authorProofSchema>;

export type AuthorKeyPair = {
  privateKey: string;
  publicKey: string;
};

export type AuthorIdentity = {
  githubId: number;
  githubLogin: string;
};

export type AuthorVerification =
  | { status: "unsigned" }
  | {
      status: "valid" | "expired";
      githubId: number;
      githubLogin: string;
      issuedAt: number;
      expiresAt: number;
    }
  | {
      status: "invalid";
      githubId?: number;
      githubLogin?: string;
      reason: string;
    };

export type AuthorCertificateVerification = Exclude<AuthorVerification, { status: "unsigned" }>;

// Add a new public key here before rotating AUTHOR_CA_KEY_ID in the Worker.
export const AUTHOR_CA_PUBLIC_KEYS: Readonly<Record<number, string>> = {
  1: "iIakS3SEmbDXHtqGGsDhiQTGgx8yB9G6orxyHyqAIwc",
};

function certificateFields(certificate: AuthorCertificate): AuthorCertificate {
  return [
    certificate[0],
    certificate[1],
    certificate[2],
    certificate[3],
    certificate[4],
    certificate[5],
    certificate[6],
    certificate[7],
  ];
}

function unsignedCertificateFields(certificate: readonly unknown[]): readonly unknown[] {
  return certificate.slice(0, 7);
}

function certificateSigningBytes(certificate: readonly unknown[]): Uint8Array {
  return concatBytes(
    CERTIFICATE_DOMAIN,
    utf8(JSON.stringify(unsignedCertificateFields(certificate))),
  );
}

function artifactSigningBytes(
  version: PayloadVersion,
  envelope: Omit<Envelope, "u">,
  certificate: AuthorCertificate,
): Uint8Array {
  const { s, i, a, c, k, notAfter, interstitialNote, ...unhandled } = envelope;
  const exhaustive: Record<string, never> = unhandled;
  void exhaustive;
  const sealedSecrets = Object.entries(envelope.k ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const artifact = [
    version,
    s,
    i === true,
    a ?? null,
    c ?? [],
    sealedSecrets,
    notAfter ?? null,
    interstitialNote ?? null,
    certificateFields(certificate),
  ];
  return concatBytes(ARTIFACT_DOMAIN, utf8(JSON.stringify(artifact)));
}

async function importPublicKey(encoded: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", Uint8Array.from(fromBase64Url(encoded)), "Ed25519", false, [
    "verify",
  ]);
}

async function importPrivateKey(encoded: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(fromBase64Url(encoded)),
    "Ed25519",
    false,
    ["sign"],
  );
}

async function verifySignature(
  publicKey: string,
  message: Uint8Array,
  signature: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    "Ed25519",
    await importPublicKey(publicKey),
    Uint8Array.from(fromBase64Url(signature)),
    Uint8Array.from(message),
  );
}

async function signWithAuthorKey(authorKey: AuthorKeyPair, message: Uint8Array): Promise<string> {
  const signature = toBase64Url(
    await crypto.subtle.sign(
      "Ed25519",
      await importPrivateKey(authorKey.privateKey),
      Uint8Array.from(message),
    ),
  );
  if (!(await verifySignature(authorKey.publicKey, message, signature))) {
    throw new Error("The local author private key does not match its public key.");
  }
  return signature;
}

export async function verifyAuthorKeyPair(authorKey: AuthorKeyPair): Promise<void> {
  await signWithAuthorKey(authorKey, KEY_CHECK_DOMAIN);
}

function assertAuthorCertificateMatchesKey(
  certificate: AuthorCertificate,
  authorKey: AuthorKeyPair,
): void {
  if (certificate[4] !== authorKey.publicKey) {
    throw new Error("The author certificate does not match the local signing key.");
  }
}

export async function verifyAuthorCredential(
  certificate: AuthorCertificate,
  authorKey: AuthorKeyPair,
): Promise<void> {
  assertAuthorCertificateMatchesKey(certificate, authorKey);
  await verifyAuthorKeyPair(authorKey);
}

export async function generateAuthorKeyPair(): Promise<AuthorKeyPair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
    crypto.subtle.exportKey("raw", pair.publicKey),
  ]);
  return {
    privateKey: toBase64Url(privateKey as ArrayBuffer),
    publicKey: toBase64Url(publicKey as ArrayBuffer),
  };
}

export async function issueAuthorCertificate(options: {
  authorPublicKey: string;
  identity: AuthorIdentity;
  issuerKeyId: number;
  issuerPrivateKey: string;
  issuedAt: number;
  expiresAt: number;
}): Promise<AuthorCertificate> {
  encodedPublicKeySchema.parse(options.authorPublicKey);
  const unsigned = [
    1,
    options.issuerKeyId,
    options.identity.githubId,
    options.identity.githubLogin,
    options.authorPublicKey,
    options.issuedAt,
    options.expiresAt,
  ] as const;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    await importPrivateKey(options.issuerPrivateKey),
    Uint8Array.from(certificateSigningBytes(unsigned)),
  );
  return authorCertificateSchema.parse([...unsigned, toBase64Url(signature)]);
}

export async function signEnvelope(
  version: PayloadVersion,
  envelope: Omit<Envelope, "u">,
  certificate: AuthorCertificate,
  authorKey: AuthorKeyPair,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<Envelope> {
  assertAuthorCertificateMatchesKey(certificate, authorKey);
  if (certificate[6] <= nowSeconds) {
    throw new Error("The author certificate has expired. Run smartlinks login again.");
  }
  const message = artifactSigningBytes(version, envelope, certificate);
  const signature = await signWithAuthorKey(authorKey, message);
  return { ...envelope, u: [certificate, signature] };
}

export async function verifyAuthorCertificate(
  certificate: AuthorCertificate,
  options: {
    issuerPublicKeys?: Readonly<Record<number, string>>;
    nowSeconds?: number;
  } = {},
): Promise<AuthorCertificateVerification> {
  const identity = { githubId: certificate[2], githubLogin: certificate[3] };
  try {
    const issuerPublicKey = (options.issuerPublicKeys ?? AUTHOR_CA_PUBLIC_KEYS)[certificate[1]];
    if (!issuerPublicKey) {
      return { status: "invalid", ...identity, reason: "Unknown certificate issuer." };
    }
    if (
      !(await verifySignature(
        issuerPublicKey,
        certificateSigningBytes(certificate),
        certificate[7],
      ))
    ) {
      return { status: "invalid", ...identity, reason: "Invalid author certificate signature." };
    }
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
    if (certificate[5] > now + 300) {
      return { status: "invalid", ...identity, reason: "Author certificate is not yet valid." };
    }
    return {
      status: certificate[6] <= now ? "expired" : "valid",
      ...identity,
      issuedAt: certificate[5],
      expiresAt: certificate[6],
    };
  } catch (error) {
    return {
      status: "invalid",
      ...identity,
      reason: error instanceof Error ? error.message : "Author certificate verification failed.",
    };
  }
}

export async function verifyAuthorProof(
  decoded: DecodedPayload,
  options: {
    issuerPublicKeys?: Readonly<Record<number, string>>;
    nowSeconds?: number;
  } = {},
): Promise<AuthorVerification> {
  const proof = decoded.envelope.u;
  if (!proof) {
    return { status: "unsigned" };
  }
  const [certificate, artifactSignature] = proof;
  const identity = { githubId: certificate[2], githubLogin: certificate[3] };
  try {
    const certificateVerification = await verifyAuthorCertificate(certificate, options);
    if (certificateVerification.status === "invalid") {
      return certificateVerification;
    }
    const { u: _proof, ...unsignedEnvelope } = decoded.envelope;
    if (
      !(await verifySignature(
        certificate[4],
        artifactSigningBytes(decoded.version, unsignedEnvelope, certificate),
        artifactSignature,
      ))
    ) {
      return { status: "invalid", ...identity, reason: "Invalid Smartlink author signature." };
    }
    return certificateVerification;
  } catch (error) {
    return {
      status: "invalid",
      ...identity,
      reason: error instanceof Error ? error.message : "Author verification failed.",
    };
  }
}
