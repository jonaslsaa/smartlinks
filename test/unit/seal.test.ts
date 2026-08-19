import { describe, expect, it } from "vitest";
import { generateAuthorKeyPair, issueAuthorCertificate } from "../../src/shared/author.js";
import type { Envelope } from "../../src/shared/codec.js";
import {
  artifactSecretBinding,
  boundSealedSecrets,
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

  it("binds every authority-bearing artifact field and the secret name", async () => {
    const pair = await generateKeyPair(1);
    const envelope: Envelope = {
      s: "async()=>1",
      c: ["async value=>value"],
      i: true as const,
      allowCrawlers: true as const,
      notAfter: 2_000_000_000,
      interstitialNote: "Deploys the reviewed release",
      browser: { scripts: ["https"] },
      cors: true as const,
    };
    const binding = artifactSecretBinding("2", envelope, "TOKEN");
    const blob = await sealSecret("top secret", binding, pair);

    await expect(openSecret(blob, binding, pair.privateKeySecret)).resolves.toBe("top secret");
    const tampered = [
      artifactSecretBinding("2", { ...envelope, s: "async()=>2" }, "TOKEN"),
      artifactSecretBinding("2", { ...envelope, c: ["async value=>String(value)"] }, "TOKEN"),
      artifactSecretBinding("2", { ...envelope, i: undefined }, "TOKEN"),
      artifactSecretBinding("2", { ...envelope, allowCrawlers: undefined }, "TOKEN"),
      artifactSecretBinding("2", { ...envelope, notAfter: (envelope.notAfter ?? 0) + 1 }, "TOKEN"),
      artifactSecretBinding("2", { ...envelope, interstitialNote: "Changed note" }, "TOKEN"),
      artifactSecretBinding("2", { ...envelope, interstitialNote: undefined }, "TOKEN"),
      artifactSecretBinding(
        "2",
        { ...envelope, browser: { scripts: ["https://cdn.example"] } },
        "TOKEN",
      ),
      artifactSecretBinding("2", { ...envelope, cors: undefined }, "TOKEN"),
      artifactSecretBinding("2", envelope, "RENAMED_TOKEN"),
    ];
    for (const changedBinding of tampered) {
      await expect(openSecret(blob, changedBinding, pair.privateKeySecret)).rejects.toThrow();
    }
  });

  it("does not let legacy sealed links gain an unauthenticated author note", async () => {
    const pair = await generateKeyPair(1);
    const script = "async()=>1";
    const blob = await sealSecret("top secret", { script }, pair);

    expect(() =>
      boundSealedSecrets({
        version: "2",
        envelope: {
          s: script,
          i: true,
          interstitialNote: "Injected note",
          k: { TOKEN: blob },
        },
      }),
    ).toThrow("complete-artifact binding");
  });

  it("does not let legacy sealed links gain unauthenticated crawler execution", async () => {
    const pair = await generateKeyPair(1);
    const script = "async()=>1";
    const blob = await sealSecret("top secret", { script }, pair);

    expect(() =>
      boundSealedSecrets({
        version: "2",
        envelope: { s: script, allowCrawlers: true, k: { TOKEN: blob } },
      }),
    ).toThrow("complete-artifact binding");
  });

  it("does not let legacy sealed links gain unauthenticated browser capabilities", async () => {
    const pair = await generateKeyPair(1);
    const script = "async()=>1";
    const blob = await sealSecret("top secret", { script }, pair);

    const capabilities: Array<Pick<Envelope, "browser" | "cors">> = [
      { browser: { scripts: ["https"] } },
      { cors: true },
    ];
    for (const enabled of capabilities) {
      expect(() =>
        boundSealedSecrets({
          version: "2",
          envelope: { s: script, k: { TOKEN: blob }, ...enabled },
        }),
      ).toThrow("complete-artifact binding");
    }
  });

  it("binds signed sealed authority to the author certificate", async () => {
    const [pair, issuer, author, otherAuthor] = await Promise.all([
      generateKeyPair(1),
      generateAuthorKeyPair(),
      generateAuthorKeyPair(),
      generateAuthorKeyPair(),
    ]);
    const certificate = await issueAuthorCertificate({
      authorPublicKey: author.publicKey,
      identity: { githubId: 123456, githubLogin: "jonaslsaa" },
      issuerKeyId: 7,
      issuerPrivateKey: issuer.privateKey,
      issuedAt: 2_000_000_000,
      expiresAt: 2_000_003_600,
    });
    const otherCertificate = await issueAuthorCertificate({
      authorPublicKey: otherAuthor.publicKey,
      identity: { githubId: 654321, githubLogin: "another-author" },
      issuerKeyId: 7,
      issuerPrivateKey: issuer.privateKey,
      issuedAt: 2_000_000_000,
      expiresAt: 2_000_003_600,
    });
    const envelope = { s: "async()=>1", a: 2 as const };
    const binding = artifactSecretBinding("2", envelope, "TOKEN", certificate);
    const blob = await sealSecret("top secret", binding, pair);

    await expect(openSecret(blob, binding, pair.privateKeySecret)).resolves.toBe("top secret");
    await expect(
      openSecret(
        blob,
        artifactSecretBinding("2", envelope, "TOKEN", otherCertificate),
        pair.privateKeySecret,
      ),
    ).rejects.toThrow();
    expect(() => artifactSecretBinding("2", envelope, "TOKEN")).toThrow(
      "require their author certificate",
    );
  });

  it("validates the one-byte rotation key ID", async () => {
    await expect(generateKeyPair(0)).rejects.toThrow("between 1 and 255");
    await expect(generateKeyPair(256)).rejects.toThrow("between 1 and 255");
  });
});
