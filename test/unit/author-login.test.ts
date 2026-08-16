import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextAuthorPollInterval,
  requestAuthorCertificate,
  requestGithubDeviceCode,
  validateIssuedCertificate,
} from "../../src/cli/author-login.js";
import {
  authorKey,
  clearStoredAuthor,
  readStoredAuthor,
  writeStoredAuthor,
} from "../../src/cli/author-store.js";
import { generateAuthorKeyPair, issueAuthorCertificate } from "../../src/shared/author.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("author login", () => {
  it("requests a GitHub App device code without caller-selected scopes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        device_code: "device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );

    await expect(requestGithubDeviceCode(fetchImpl)).resolves.toMatchObject({
      user_code: "ABCD-1234",
    });
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(String(request?.body)).not.toContain("scope=");
  });

  it("polls pending and issued certificate responses without exposing a token", async () => {
    const [issuer, author] = await Promise.all([generateAuthorKeyPair(), generateAuthorKeyPair()]);
    const certificate = await issueAuthorCertificate({
      authorPublicKey: author.publicKey,
      identity: { githubId: 123456, githubLogin: "jonaslsaa" },
      issuerKeyId: 1,
      issuerPrivateKey: issuer.privateKey,
      issuedAt: 2_000_000_000,
      expiresAt: 2_000_003_600,
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "pending", interval: 10 }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ certificate }));

    await expect(
      requestAuthorCertificate(
        "https://runtime.example",
        "device-code",
        author.publicKey,
        fetchImpl,
      ),
    ).resolves.toEqual({ status: "pending", interval: 10 });
    await expect(
      requestAuthorCertificate(
        "https://runtime.example",
        "device-code",
        author.publicKey,
        fetchImpl,
      ),
    ).resolves.toEqual({ status: "issued", certificate });
  });

  it("backs off by five seconds for every GitHub slow-down response", () => {
    expect(nextAuthorPollInterval(5, { status: "slow_down" })).toBe(10);
    expect(nextAuthorPollInterval(10, { status: "slow_down" })).toBe(15);
    expect(nextAuthorPollInterval(15, { status: "pending", interval: 7 })).toBe(15);
  });

  it("authenticates an issued certificate before it can be stored", async () => {
    const [issuer, attacker, author] = await Promise.all([
      generateAuthorKeyPair(),
      generateAuthorKeyPair(),
      generateAuthorKeyPair(),
    ]);
    const certificate = await issueAuthorCertificate({
      authorPublicKey: author.publicKey,
      identity: { githubId: 123456, githubLogin: "jonaslsaa" },
      issuerKeyId: 9,
      issuerPrivateKey: issuer.privateKey,
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    });

    await expect(
      validateIssuedCertificate(certificate, author, { 9: issuer.publicKey }),
    ).resolves.toBeUndefined();
    await expect(
      validateIssuedCertificate(certificate, attacker, { 9: issuer.publicKey }),
    ).rejects.toThrow("different signing key");
    await expect(validateIssuedCertificate(certificate, author, {})).rejects.toThrow(
      "Unknown certificate issuer",
    );
  });

  it("stores only the local key and certificate in a private file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smartlinks-author-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "author.json");
    const [issuer, key] = await Promise.all([generateAuthorKeyPair(), generateAuthorKeyPair()]);
    const certificate = await issueAuthorCertificate({
      authorPublicKey: key.publicKey,
      identity: { githubId: 123456, githubLogin: "jonaslsaa" },
      issuerKeyId: 1,
      issuerPrivateKey: issuer.privateKey,
      issuedAt: 2_000_000_000,
      expiresAt: 2_000_003_600,
    });

    await writeStoredAuthor({ service: "https://s.jonaslsa.com", key, certificate }, path);
    const stored = await readStoredAuthor(path);
    expect(stored?.certificate).toEqual(certificate);
    expect(stored?.service).toBe("https://s.jonaslsa.com");
    expect(stored && authorKey(stored)).toEqual(key);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await expect(clearStoredAuthor(path)).resolves.toBe(true);
    await expect(readStoredAuthor(path)).resolves.toBeUndefined();
  });

  it("requires login again for legacy identities without a runtime scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smartlinks-author-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "author.json");
    await writeFile(path, '{"version":1}\n', { mode: 0o600 });

    await expect(readStoredAuthor(path)).rejects.toThrow(
      "predates runtime-scoped signing. Run smartlinks login again",
    );
  });
});
