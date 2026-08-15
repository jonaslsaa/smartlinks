import { deflateRawSync } from "node:zlib";
import { deflateSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { createSmartlink } from "../../src/cli/build.js";
import { toBase64Url } from "../../src/shared/bytes.js";
import { encodePayload, MAX_DECOMPRESSED_LENGTH } from "../../src/shared/codec.js";
import { generateKeyPair, sealSecret } from "../../src/shared/seal.js";
import { decodeWorkerPayload, inflateRawWithLimit } from "../../src/worker/codec.js";
import worker from "../../src/worker/index.js";
import { validateWorkerScript } from "../../src/worker/sandbox.js";

const origin = "https://runtime.example";
let pair: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  pair = await generateKeyPair(1);
});

function testEnv() {
  return {
    ACTIVE_KEY_ID: "1" as const,
    LANDING_URL: "https://sl.jonaslsa.com/" as const,
    PRIVATE_KEY_1: pair.privateKeySecret,
  };
}

describe("Worker routes", () => {
  it("redirects only the root and serves the active public key", async () => {
    const root = await worker.fetch(new Request(origin), testEnv());
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://sl.jonaslsa.com/");
    expect(root.headers.get("cache-control")).toBe("no-store");

    const head = await worker.fetch(new Request(origin, { method: "HEAD" }), testEnv());
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe("https://sl.jonaslsa.com/");

    const health = await worker.fetch(new Request(`${origin}/health`), testEnv());
    expect(health.status).toBe(404);

    const response = await worker.fetch(new Request(`${origin}/pk`), testEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ keyId: 1, publicKey: pair.publicKey });
  });

  it("executes a CLI-built link with params and sealed secrets", async () => {
    const created = await createSmartlink({
      source: `return { status: 201, headers: { "x-runtime": "quickjs" }, body: \`\${ctx.params.name}:\${ctx.secrets.TOKEN}\` }`,
      service: origin,
      secrets: { TOKEN: "sealed-value" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(`${created.link}?name=Jonas`), testEnv());

    expect(response.status).toBe(201);
    expect(response.headers.get("x-runtime")).toBe("quickjs");
    await expect(response.text()).resolves.toBe("Jonas:sealed-value");
  });

  it("supports legacy version 1 links", async () => {
    const payload = encodePayload({ s: 'return { body: "legacy" }' }, "1");
    const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv());
    await expect(response.text()).resolves.toBe("legacy");
  });

  it("executes highly compressible source above the old source limit", async () => {
    const created = await createSmartlink({
      source: `${"// padding\n".repeat(4_000)}return { body: "large" }`,
      service: origin,
      minify: false,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.link), testEnv());

    expect(created.source.length).toBeGreaterThan(32_000);
    await expect(response.text()).resolves.toBe("large");
  });

  it("requires and processes an opt-in interstitial", async () => {
    const created = await createSmartlink({
      source: 'return { body: "confirmed" }',
      service: origin,
      interstitial: true,
      validate: validateWorkerScript,
    });
    const review = await worker.fetch(new Request(created.link), testEnv());
    expect(review.headers.get("content-type")).toContain("text/html");
    await expect(review.text()).resolves.toContain("Review before running");

    const execution = await worker.fetch(
      new Request(`${created.link}?__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    await expect(execution.text()).resolves.toBe("confirmed");
  });

  it("never executes preview or prefetch requests", async () => {
    const payload = encodePayload({ s: "this is not valid JavaScript" }, "1");
    const response = await worker.fetch(
      new Request(`${origin}/r/${payload}`, {
        headers: { "user-agent": "Slackbot-LinkExpanding" },
      }),
      testEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Preview requests never execute it");

    const head = await worker.fetch(
      new Request(`${origin}/r/${payload}`, { method: "HEAD" }),
      testEnv(),
    );
    expect(head.status).toBe(200);
    await expect(head.text()).resolves.toBe("");
  });

  it("provides a non-executing decoder page", async () => {
    const created = await createSmartlink({
      source: 'return { body: "decoded" }',
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.decoder), testEnv());
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Decoded smartlink");
  });

  it("rejects a sealed blob copied to another script", async () => {
    const original = "async()=>({body:'original'})";
    const blob = await sealSecret("secret", original, pair);
    const payload = encodePayload({ s: "async()=>({body:'changed'})", k: { TOKEN: blob } });
    const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Sealed secret TOKEN could not be decrypted.",
    });
  });

  it("returns bounded errors for malformed links and missing routes", async () => {
    const malformed = await worker.fetch(new Request(`${origin}/r/2broken`), testEnv());
    expect(malformed.status).toBe(400);

    const missing = await worker.fetch(new Request(`${origin}/unknown`), testEnv());
    expect(missing.status).toBe(404);
  });
});

describe("Worker payload decoder", () => {
  it("cross-decodes current fflate payloads for both versions", async () => {
    const envelope = { s: 'return { body: "native stream" }', i: true as const };

    for (const version of ["1", "2"] as const) {
      await expect(decodeWorkerPayload(encodePayload(envelope, version))).resolves.toEqual({
        version,
        envelope,
      });
    }
  });

  it("cancels highly compressible output above its configured ceiling", async () => {
    const compressed = deflateSync(new Uint8Array(128_000), { level: 9 });

    await expect(inflateRawWithLimit(compressed, 32_000)).rejects.toThrow(
      "decoded payload is too large",
    );
  });

  it("safely rejects a near-maximum URL that expands to six megabytes", async () => {
    const compressed = deflateRawSync(new Uint8Array(6_000_000), { level: 9 });
    const payload = `2${toBase64Url(compressed)}`;

    expect(payload.length).toBeLessThan(7_800);
    expect(6_000_000).toBeLessThan(MAX_DECOMPRESSED_LENGTH);
    await expect(decodeWorkerPayload(payload)).rejects.toThrow("invalid or corrupted");
  });
});
