import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runCli, withTemporaryScript } from "./helpers.mjs";

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function createTestAuthor(configDirectory, options = {}) {
  const [issuer, author] = await Promise.all([
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  ]);
  const [issuerPublic, authorPrivate, authorPublic] = await Promise.all([
    crypto.subtle.exportKey("raw", issuer.publicKey),
    crypto.subtle.exportKey("pkcs8", author.privateKey),
    crypto.subtle.exportKey("raw", author.publicKey),
  ]);
  const now = Math.floor(Date.now() / 1_000);
  const issuedAt = options.expired ? now - 3_600 : now;
  const expiresAt = options.expired ? now - 1 : now + 3_600;
  const unsigned = [1, 128, 123456, "jonaslsaa", toBase64Url(authorPublic), issuedAt, expiresAt];
  const certificateSignature = await crypto.subtle.sign(
    "Ed25519",
    issuer.privateKey,
    Buffer.concat([
      Buffer.from("smartlinks/author-certificate/v1\0"),
      Buffer.from(JSON.stringify(unsigned)),
    ]),
  );
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDirectory, "author.json"),
    `${JSON.stringify({
      version: 2,
      service: options.service ?? "https://s.jonaslsa.com",
      privateKey: toBase64Url(authorPrivate),
      publicKey: toBase64Url(authorPublic),
      certificate: [...unsigned, toBase64Url(certificateSignature)],
    })}\n`,
    { mode: 0o600 },
  );
  return toBase64Url(issuerPublic);
}

test("whoami reports signing readiness and fails closed for unusable identities", async () => {
  await withTemporaryScript("js", 'return "unused";\n', async (script) => {
    const directory = dirname(script);
    const missingConfig = join(directory, "missing-author");
    await assert.rejects(
      runCli(["whoami", "--json"], {
        env: { ...process.env, SMARTLINKS_CONFIG_DIR: missingConfig },
      }),
      (error) => {
        assert.deepEqual(JSON.parse(error.stdout), { status: "missing" });
        assert.equal(error.stderr, "");
        return true;
      },
    );

    const validConfig = join(directory, "valid-author");
    const issuerPublicKey = await createTestAuthor(validConfig);
    const validEnv = {
      ...process.env,
      SMARTLINKS_CONFIG_DIR: validConfig,
      SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: issuerPublicKey,
    };
    const valid = await runCli(["whoami", "--json"], { env: validEnv });
    const status = JSON.parse(valid.stdout);
    assert.equal(status.status, "valid");
    assert.equal(status.githubId, 123456);
    assert.equal(status.githubLogin, "jonaslsaa");
    assert.equal(status.service, "https://s.jonaslsa.com");
    assert.equal(typeof status.issuedAt, "number");
    assert.equal(typeof status.expiresAt, "number");
    assert.equal(valid.stderr, "");

    const human = await runCli(["whoami"], { env: validEnv });
    assert.match(
      human.stdout,
      /^github\.com\/jonaslsaa · https:\/\/s\.jonaslsa\.com · certificate expires \d{4}-/u,
    );
    assert.equal(human.stderr, "");

    const malformedConfig = join(directory, "malformed-author");
    await mkdir(malformedConfig, { recursive: true });
    await writeFile(join(malformedConfig, "author.json"), '{"version":2}\n', { mode: 0o600 });
    await assert.rejects(
      runCli(["whoami", "--json"], {
        env: { ...process.env, SMARTLINKS_CONFIG_DIR: malformedConfig },
      }),
      (error) => {
        const invalid = JSON.parse(error.stdout);
        assert.deepEqual(invalid, {
          status: "invalid",
          reason: "The stored author credential is invalid. Run smartlinks login again.",
        });
        assert.equal(error.stderr, "");
        return true;
      },
    );

    await assert.rejects(
      runCli(["whoami", "--json"], {
        env: { ...process.env, SMARTLINKS_CONFIG_DIR: validConfig },
      }),
      (error) => {
        const invalid = JSON.parse(error.stdout);
        assert.equal(invalid.status, "invalid");
        assert.match(invalid.reason, /Unknown certificate issuer/u);
        assert.equal(error.stderr, "");
        return true;
      },
    );

    const brokenKeyConfig = join(directory, "broken-key-author");
    const brokenKeyIssuer = await createTestAuthor(brokenKeyConfig);
    const brokenCredentialPath = join(brokenKeyConfig, "author.json");
    const brokenCredential = JSON.parse(await readFile(brokenCredentialPath, "utf8"));
    brokenCredential.privateKey = "not-a-private-key";
    await writeFile(brokenCredentialPath, `${JSON.stringify(brokenCredential)}\n`, { mode: 0o600 });
    await assert.rejects(
      runCli(["whoami", "--json"], {
        env: {
          ...process.env,
          SMARTLINKS_CONFIG_DIR: brokenKeyConfig,
          SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: brokenKeyIssuer,
        },
      }),
      (error) => {
        const invalid = JSON.parse(error.stdout);
        assert.equal(invalid.status, "invalid");
        assert.doesNotMatch(error.stdout, /not-a-private-key/u);
        assert.equal(error.stderr, "");
        return true;
      },
    );

    const mismatchedKeyConfig = join(directory, "mismatched-key-author");
    const mismatchedKeyIssuer = await createTestAuthor(mismatchedKeyConfig);
    const mismatchedCredentialPath = join(mismatchedKeyConfig, "author.json");
    const mismatchedCredential = JSON.parse(await readFile(mismatchedCredentialPath, "utf8"));
    const replacement = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const [replacementPrivate, replacementPublic] = await Promise.all([
      crypto.subtle.exportKey("pkcs8", replacement.privateKey),
      crypto.subtle.exportKey("raw", replacement.publicKey),
    ]);
    mismatchedCredential.privateKey = toBase64Url(replacementPrivate);
    mismatchedCredential.publicKey = toBase64Url(replacementPublic);
    await writeFile(mismatchedCredentialPath, `${JSON.stringify(mismatchedCredential)}\n`, {
      mode: 0o600,
    });
    const mismatchedEnv = {
      ...process.env,
      SMARTLINKS_CONFIG_DIR: mismatchedKeyConfig,
      SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: mismatchedKeyIssuer,
    };
    for (const args of [
      ["whoami", "--json"],
      ["build", script, "--json"],
    ]) {
      await assert.rejects(runCli(args, { env: mismatchedEnv }), (error) => {
        const output = args[0] === "whoami" ? JSON.parse(error.stdout) : error.stderr;
        assert.match(
          typeof output === "string" ? output : output.reason,
          /stored author signing key is invalid/iu,
        );
        assert.doesNotMatch(
          error.stdout + error.stderr,
          new RegExp(mismatchedCredential.privateKey),
        );
        return true;
      });
    }

    const expiredConfig = join(directory, "expired-author");
    const expiredIssuer = await createTestAuthor(expiredConfig, { expired: true });
    await assert.rejects(
      runCli(["whoami", "--json"], {
        env: {
          ...process.env,
          SMARTLINKS_CONFIG_DIR: expiredConfig,
          SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: expiredIssuer,
        },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stdout).status, "expired");
        assert.equal(error.stderr, "");
        return true;
      },
    );

    await assert.rejects(
      runCli(["build", script, "--json"], {
        env: {
          ...process.env,
          SMARTLINKS_CONFIG_DIR: expiredConfig,
          SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: expiredIssuer,
        },
      }),
      (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /certificate has expired.*--no-sign/iu);
        return true;
      },
    );
  });
});

test("build stays unsigned without an identity and --no-sign bypasses stored identity checks", async () => {
  await withTemporaryScript("js", 'return { body: "unsigned" };', async (script) => {
    const configDirectory = join(dirname(script), "empty-config");
    const unsigned = await runCli(["build", script, "--json"], {
      env: { ...process.env, SMARTLINKS_CONFIG_DIR: configDirectory },
    });
    assert.equal(JSON.parse(unsigned.stdout).signed, false);
    assert.equal(unsigned.stderr, "");

    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "author.json"), "not json\n", { mode: 0o600 });
    const explicitlyUnsigned = await runCli(["build", script, "--no-sign", "--json"], {
      env: { ...process.env, SMARTLINKS_CONFIG_DIR: configDirectory },
    });
    assert.equal(JSON.parse(explicitlyUnsigned.stdout).signed, false);
    assert.equal(explicitlyUnsigned.stderr, "");
  });
});

test("build automatically signs with the configured author and decode verifies it offline", async () => {
  await withTemporaryScript("js", 'return { body: "signed" };', async (script) => {
    const configDirectory = join(dirname(script), "author-config");
    const issuerPublicKey = await createTestAuthor(configDirectory);
    const env = {
      ...process.env,
      SMARTLINKS_CONFIG_DIR: configDirectory,
      SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: issuerPublicKey,
    };
    const built = await runCli(["build", script, "--json"], { env });
    const output = JSON.parse(built.stdout);
    assert.equal(built.stderr, "");
    assert.equal(output.signed, true);
    assert.equal(output.author, "jonaslsaa");
    assert.equal(typeof output.signingOverhead, "number");
    assert.ok(output.signingOverhead > 0);

    const decoded = await runCli(["decode", output.link, "--json"], { env });
    assert.equal(decoded.stderr, "");
    const verifiedAuthor = JSON.parse(decoded.stdout).author;
    assert.equal(verifiedAuthor.status, "valid");
    assert.equal(verifiedAuthor.githubId, 123456);
    assert.equal(verifiedAuthor.githubLogin, "jonaslsaa");
    assert.equal(typeof verifiedAuthor.issuedAt, "number");
    assert.equal(typeof verifiedAuthor.expiresAt, "number");

    const outputFile = join(dirname(script), "signed-link.txt");
    const receipt = await runCli(["build", script, "--out", outputFile], { env });
    assert.match(receipt.stdout, /signed by github\.com\/jonaslsaa · \+[\d,]+ characters/u);
    assert.doesNotMatch(receipt.stdout, /https:\/\/s\.jonaslsa\.com\/r\//u);
    assert.match(await readFile(outputFile, "utf8"), /^https:\/\/s\.jonaslsa\.com\/r\//u);

    const plain = await runCli(["build", script], { env });
    assert.match(plain.stdout, /^https:\/\/s\.jonaslsa\.com\/r\//u);
    assert.match(plain.stderr, /signed by github\.com\/jonaslsaa · \+[\d,]+ characters/u);
  });
});

test("automatic signing is scoped to the runtime that issued the identity", async () => {
  await withTemporaryScript("js", 'return { body: "scoped" };', async (script) => {
    const configDirectory = join(dirname(script), "author-config");
    const issuerPublicKey = await createTestAuthor(configDirectory);
    const env = {
      ...process.env,
      SMARTLINKS_CONFIG_DIR: configDirectory,
      SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: issuerPublicKey,
      SMARTLINKS_URL: "https://other-runtime.example",
    };

    await assert.rejects(runCli(["build", script, "--json"], { env }), (error) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /belongs to https:\/\/s\.jonaslsa\.com.*--no-sign/iu);
      return true;
    });

    await assert.rejects(runCli(["whoami", "--json"], { env }), (error) => {
      const status = JSON.parse(error.stdout);
      assert.equal(status.status, "wrong-runtime");
      assert.equal(status.githubId, 123456);
      assert.equal(status.githubLogin, "jonaslsaa");
      assert.equal(status.service, "https://s.jonaslsa.com");
      assert.equal(status.selectedService, "https://other-runtime.example");
      assert.equal(typeof status.issuedAt, "number");
      assert.equal(typeof status.expiresAt, "number");
      assert.equal(error.stderr, "");
      return true;
    });

    const unsigned = await runCli(["build", script, "--no-sign", "--json"], { env });
    const output = JSON.parse(unsigned.stdout);
    assert.equal(output.signed, false);
    assert.match(output.link, /^https:\/\/other-runtime\.example\/r\//u);
  });
});

test("automatic signing never falls back to unsigned when the signature exceeds the budget", async () => {
  const cases = Array.from(
    { length: 1_200 },
    (_, index) => `case "action${index}": return { body: "result${index}" };`,
  ).join("\n");
  await withTemporaryScript(
    "js",
    `switch (ctx.params.x) {\n${cases}\ndefault: return { status: 404 };\n}`,
    async (script) => {
      const configDirectory = join(dirname(script), "author-config");
      const issuerPublicKey = await createTestAuthor(configDirectory);
      const env = {
        ...process.env,
        SMARTLINKS_CONFIG_DIR: configDirectory,
        SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: issuerPublicKey,
      };

      await assert.rejects(runCli(["build", script, "--json"], { env }), (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /encoded payload.*limit.*--no-sign/isu);
        return true;
      });

      const unsigned = await runCli(["build", script, "--no-sign", "--json"], { env });
      assert.equal(JSON.parse(unsigned.stdout).signed, false);
    },
  );
});

test("author-keygen emits a usable Ed25519 issuer key pair", async () => {
  const result = await runCli(["author-keygen", "--key-id", "7", "--json"]);
  const key = JSON.parse(result.stdout);

  assert.equal(key.keyId, 7);
  assert.match(key.publicKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(key.privateKey, /^[A-Za-z0-9_-]+$/u);
  assert.equal(result.stderr, "");
});
