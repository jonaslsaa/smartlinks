import { describe, expect, it } from "vitest";
import {
  authorProofSchema,
  generateAuthorKeyPair,
  issueAuthorCertificate,
  signEnvelope,
  verifyAuthorProof,
} from "../../src/shared/author.js";
import type { DecodedPayload } from "../../src/shared/codec.js";

const FIXTURE_NOW = 2_000_000_000;

async function signedPayload(now = FIXTURE_NOW) {
  const [issuer, author] = await Promise.all([generateAuthorKeyPair(), generateAuthorKeyPair()]);
  const certificate = await issueAuthorCertificate({
    authorPublicKey: author.publicKey,
    identity: { githubId: 123456, githubLogin: "jonaslsaa" },
    issuerKeyId: 7,
    issuerPrivateKey: issuer.privateKey,
    issuedAt: now,
    expiresAt: now + 3_600,
  });
  const envelope = await signEnvelope(
    "2",
    {
      s: 'async ctx=>({body:"hello"})',
      i: true,
      a: 2,
      c: ['async ctx=>({body:"child"})'],
      k: { TOKEN: "sealed-value" },
      allowCrawlers: true,
      notAfter: now + 1_800,
      interstitialNote: "Signed release helper",
      browser: { scripts: ["https"] },
      cors: true,
    },
    certificate,
    author,
    now,
  );
  return {
    author,
    decoded: { version: "2", envelope } satisfies DecodedPayload,
    issuer,
    now,
  };
}

function withoutInterstitial(decoded: DecodedPayload) {
  const { i: _interstitial, ...envelope } = decoded.envelope;
  return envelope;
}

function withoutBindingMode(decoded: DecodedPayload) {
  const { a: _bindingMode, ...envelope } = decoded.envelope;
  return envelope;
}

describe("author signatures", () => {
  it("verifies a certificate and complete artifact offline", async () => {
    const fixture = await signedPayload();
    await expect(
      verifyAuthorProof(fixture.decoded, {
        issuerPublicKeys: { 7: fixture.issuer.publicKey },
        nowSeconds: fixture.now + 60,
      }),
    ).resolves.toEqual({
      status: "valid",
      githubId: 123456,
      githubLogin: "jonaslsaa",
      issuedAt: fixture.now,
      expiresAt: fixture.now + 3_600,
    });
  });

  it("keeps the artifact signature valid but expires the identity certificate", async () => {
    const fixture = await signedPayload();
    const verification = await verifyAuthorProof(fixture.decoded, {
      issuerPublicKeys: { 7: fixture.issuer.publicKey },
      nowSeconds: fixture.now + 3_600,
    });
    expect(verification.status).toBe("expired");
  });

  it.each([
    ["script", (decoded: DecodedPayload) => ({ ...decoded.envelope, s: `${decoded.envelope.s} ` })],
    ["interstitial", withoutInterstitial],
    ["binding mode", withoutBindingMode],
    [
      "crawler policy",
      (decoded: DecodedPayload) => ({ ...decoded.envelope, allowCrawlers: undefined }),
    ],
    ["closures", (decoded: DecodedPayload) => ({ ...decoded.envelope, c: [] })],
    [
      "sealed secrets",
      (decoded: DecodedPayload) => ({ ...decoded.envelope, k: { TOKEN: "changed" } }),
    ],
    [
      "expiry",
      (decoded: DecodedPayload) => ({ ...decoded.envelope, notAfter: FIXTURE_NOW + 1_801 }),
    ],
    [
      "author note",
      (decoded: DecodedPayload) => ({ ...decoded.envelope, interstitialNote: "Changed note" }),
    ],
    [
      "browser policy",
      (decoded: DecodedPayload) => ({
        ...decoded.envelope,
        browser: { scripts: ["https://cdn.example" as const] },
      }),
    ],
    ["CORS policy", (decoded: DecodedPayload) => ({ ...decoded.envelope, cors: undefined })],
  ] as const)("rejects a mutation to %s", async (_field, mutate) => {
    const fixture = await signedPayload();
    const tampered: DecodedPayload = {
      ...fixture.decoded,
      envelope: mutate(fixture.decoded),
    };
    const verification = await verifyAuthorProof(tampered, {
      issuerPublicKeys: { 7: fixture.issuer.publicKey },
      nowSeconds: fixture.now,
    });
    expect(verification).toMatchObject({
      status: "invalid",
      reason: "Invalid Smartlink author signature.",
    });
  });

  it("rejects a certificate for another local key", async () => {
    const fixture = await signedPayload();
    const other = await generateAuthorKeyPair();
    const proof = fixture.decoded.envelope.u;
    if (!proof) {
      throw new Error("Expected an author proof.");
    }
    await expect(
      signEnvelope("2", { s: 'async ctx=>({body:"hello"})' }, proof[0], other, fixture.now),
    ).rejects.toThrow("does not match the local signing key");
  });

  it("rejects oversized encoded keys and signatures before cryptographic verification", () => {
    const oversized = "A".repeat(1_000_000);
    expect(
      authorProofSchema.safeParse([
        [1, 1, 123456, "jonaslsaa", oversized, FIXTURE_NOW, FIXTURE_NOW + 60, oversized],
        oversized,
      ]).success,
    ).toBe(false);
  });
});
