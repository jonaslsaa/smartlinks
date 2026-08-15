import { deflateRawSync } from "node:zlib";
import { deflateSync } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

function testEnv(
  executionRateLimiter: RateLimit = {
    limit: async () => ({ success: true }),
  },
): Env & { PRIVATE_KEY_1: string } {
  return {
    ACTIVE_KEY_ID: "1",
    EXECUTION_RATE_LIMITER: executionRateLimiter,
    LANDING_URL: "https://smartlinks.jonaslsa.com/",
    RUNTIME_HOSTNAMES: ["s.jonaslsa.com"],
    PRIVATE_KEY_1: pair.privateKeySecret,
  };
}

describe("Worker routes", () => {
  it("redirects only the root and serves the active public key", async () => {
    const root = await worker.fetch(new Request(origin), testEnv());
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://smartlinks.jonaslsa.com/");
    expect(root.headers.get("cache-control")).toBe("no-store");

    const head = await worker.fetch(new Request(origin, { method: "HEAD" }), testEnv());
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe("https://smartlinks.jonaslsa.com/");

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

  it("blocks guest fetches to the active runtime and configured aliases", async () => {
    for (const hostname of ["runtime.example", "s.jonaslsa.com"]) {
      const created = await createSmartlink({
        source: `
          try {
            await fetch("https://${hostname}/pk");
            return { body: "unexpected success" };
          } catch (error) {
            return { body: String(error) };
          }
        `,
        service: origin,
        validate: validateWorkerScript,
      });

      const response = await worker.fetch(new Request(created.link), testEnv());

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain(
        "Fetches to the Smartlinks runtime are blocked.",
      );
    }
  });

  it("mints and executes a sealed child through the real guest bridge", async () => {
    const parentNotAfter = Math.floor(Date.now() / 1_000) + 60 * 60;
    const created = await createSmartlink({
      source: `
        const child = async (name) => ({
          headers: { "x-smartlinks-child": "yes" },
          body: name + ":" + ctx.secrets.CHILD_TOKEN,
        });
        return ctx.compile(child, [ctx.params.name ?? "world"], {
          seal: { CHILD_TOKEN: ctx.secrets.PARENT_TOKEN },
          ttlSeconds: 120,
          interstitial: false,
        });
      `,
      service: origin,
      interstitial: true,
      notAfter: parentNotAfter,
      secrets: { PARENT_TOKEN: "delegated-value" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const parent = await worker.fetch(
      new Request(`${created.link}?name=Jonas&__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    const childUrl = parent.headers.get("location");

    expect(parent.status).toBe(302);
    expect(childUrl).toMatch(/^https:\/\/runtime\.example\/r\/2/u);
    if (!childUrl) {
      throw new Error("Expected the parent to return a child URL.");
    }
    const decodedChild = await decodeWorkerPayload(new URL(childUrl).pathname.slice(3));
    expect(decodedChild.envelope.i).toBeUndefined();
    expect(decodedChild.envelope.notAfter).toBeLessThanOrEqual(parentNotAfter);
    expect(decodedChild.envelope.notAfter).toBeGreaterThan(Math.floor(Date.now() / 1_000));
    expect(decodedChild.envelope.a).toBe(1);
    expect(decodedChild.envelope.c).toHaveLength(1);

    const child = await worker.fetch(new Request(childUrl), testEnv());
    expect(child.status).toBe(200);
    expect(child.headers.get("x-smartlinks-child")).toBe("yes");
    await expect(child.text()).resolves.toBe("Jonas:delegated-value");
  });

  it("allows a child to mint another ordinary smartlink without generation metadata", async () => {
    const created = await createSmartlink({
      source: `
        const leaf = async (name) => ({ body: "leaf:" + name });
        const child = async (name) => ctx.compile(leaf, [name]);
        return ctx.compile(child, ["Jonas"]);
      `,
      service: origin,
      validate: validateWorkerScript,
    });
    const parent = await worker.fetch(new Request(created.link), testEnv());
    const childUrl = parent.headers.get("location");
    expect(childUrl).toBeTruthy();

    const child = await worker.fetch(new Request(childUrl ?? ""), testEnv());
    const leafUrl = child.headers.get("location");
    expect(leafUrl).toBeTruthy();

    const leaf = await worker.fetch(new Request(leafUrl ?? ""), testEnv());
    expect(leaf.status).toBe(200);
    await expect(leaf.text()).resolves.toBe("leaf:Jonas");
    const decodedLeaf = await decodeWorkerPayload(new URL(leafUrl ?? "").pathname.slice(3));
    expect(Object.keys(decodedLeaf.envelope)).not.toContain("generation");
  });

  it("charges the single mint budget before failed compile work", async () => {
    const created = await createSmartlink({
      source: `
        const child = async () => ({ body: "unused" });
        try { await ctx.compile(child, [], { bogus: true }); } catch {}
        return ctx.compile(child, []);
      `,
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.link), testEnv());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "The smartlink script failed." });
  });

  it("rejects parent secret plaintext in child arguments", async () => {
    const created = await createSmartlink({
      source: `
        const child = async (value) => ({ body: value });
        return ctx.compile(child, [ctx.secrets.PARENT_TOKEN]);
      `,
      service: origin,
      secrets: { PARENT_TOKEN: "must-not-leak" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.link), testEnv());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "The smartlink script failed." });
  });

  it("returns byte-identical calendar and PNG responses", async () => {
    const calendar = new TextEncoder().encode("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    const calendarBase64 = btoa(String.fromCharCode(...calendar));
    const calendarLink = await createSmartlink({
      source: `return { headers: { "content-type": "text/calendar" }, bodyBase64: ${JSON.stringify(calendarBase64)} }`,
      service: origin,
      validate: validateWorkerScript,
    });
    const calendarResponse = await worker.fetch(new Request(calendarLink.link), testEnv());

    expect(calendarResponse.headers.get("content-type")).toBe("text/calendar");
    expect(new Uint8Array(await calendarResponse.arrayBuffer())).toEqual(calendar);

    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const pngBase64 = btoa(String.fromCharCode(...png));
    const pngLink = await createSmartlink({
      source: `return { bodyBase64: ${JSON.stringify(pngBase64)} }`,
      service: origin,
      validate: validateWorkerScript,
    });
    const pngResponse = await worker.fetch(new Request(pngLink.link), testEnv());

    expect(pngResponse.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await pngResponse.arrayBuffer())).toEqual(png);
  });

  it("returns clear errors for invalid binary responses", async () => {
    const cases = [
      {
        source: 'return { body: "text", bodyBase64: "dGV4dA==" }',
        error: "A response cannot include both body and bodyBase64.",
      },
      {
        source: 'return { bodyBase64: "not base64" }',
        error: "bodyBase64 must be valid Base64.",
      },
      {
        source: 'return { bodyBase64: "A".repeat(1398104) }',
        error: "bodyBase64 exceeds the 1 MB decoded body limit.",
      },
    ];

    for (const testCase of cases) {
      const created = await createSmartlink({
        source: testCase.source,
        service: origin,
        validate: validateWorkerScript,
      });
      const response = await worker.fetch(new Request(created.link), testEnv());

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({ error: testCase.error });
    }
  });

  it("executes a link before its expiry", async () => {
    const created = await createSmartlink({
      source: 'return { body: "still valid" }',
      service: origin,
      notAfter: Math.floor(Date.now() / 1_000) + 60 * 60,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.link), testEnv());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("still valid");
  });

  it("returns 410 before executing an expired script", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const payload = encodePayload({
      s: "this is not valid JavaScript",
      i: true,
      k: { TOKEN: "not-a-valid-sealed-secret" },
      notAfter: Math.floor(Date.now() / 1_000) - 1,
    });
    const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv({ limit }));

    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("This link has expired");
    expect(limit).not.toHaveBeenCalled();
  });

  it("supplies repeated params, request IDs, and crypto in production", async () => {
    const created = await createSmartlink({
      source: `
        const signature = await ctx.crypto.hmacSha256("key", "message");
        return { body: [ctx.paramValues.tag.join(","), ctx.requestId, await ctx.crypto.verifyHmacSha256("key", "message", signature)].join(":") };
      `,
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(
      new Request(`${created.link}?tag=one&tag=two`, { headers: { "cf-ray": "ray-123" } }),
      testEnv(),
    );

    await expect(response.text()).resolves.toBe("one,two:ray-123:true");
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
    const notAfter = Math.floor(Date.now() / 1_000) + 60 * 60;
    const created = await createSmartlink({
      source: 'return { body: "confirmed" }',
      service: origin,
      interstitialNote: '  Deploys <script>alert("x")</script>\n after review  ',
      notAfter,
      secrets: { RELEASE_TOKEN: "never render this value" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const review = await worker.fetch(new Request(created.link), testEnv());
    expect(review.headers.get("content-type")).toContain("text/html");
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Review before running");
    expect(reviewHtml).toContain("This link runs a program");
    expect(reviewHtml).toContain("Author-provided note");
    expect(reviewHtml).toContain(
      "Deploys &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; after review",
    );
    expect(reviewHtml).not.toContain('<script>alert("x")</script>');
    expect(reviewHtml).toContain("Payload version");
    expect(reviewHtml).toContain(new Date(notAfter * 1_000).toISOString());
    expect(reviewHtml).toContain("RELEASE_TOKEN");
    expect(reviewHtml).not.toContain("never render this value");
    expect(reviewHtml).toContain("Compile closures");

    const execution = await worker.fetch(
      new Request(`${created.link}?__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    await expect(execution.text()).resolves.toBe("confirmed");
  });

  it("rate limits executions without charging previews or interstitial reviews", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const limitedEnv = testEnv({ limit });
    const created = await createSmartlink({
      source: 'return { body: "limited" }',
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(
      new Request(created.link, { headers: { "cf-connecting-ip": "203.0.113.10" } }),
      limitedEnv,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: "Too many Smartlink executions. Try again shortly.",
    });
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.10" });

    const interstitial = await createSmartlink({
      source: 'return { body: "reviewed" }',
      service: origin,
      interstitial: true,
      validate: validateWorkerScript,
    });
    const review = await worker.fetch(new Request(interstitial.link), limitedEnv);
    expect(review.status).toBe(200);

    const preview = await worker.fetch(
      new Request(created.link, { headers: { "user-agent": "Slackbot-LinkExpanding" } }),
      limitedEnv,
    );
    expect(preview.status).toBe(200);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("never executes preview or prefetch requests", async () => {
    const payload = encodePayload({ s: "this is not valid JavaScript", notAfter: 1 });
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
      interstitialNote: "Explains the decoded action",
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.decoder), testEnv());
    expect(response.status).toBe(200);
    const decodedHtml = await response.text();
    expect(decodedHtml).toContain("Decoded smartlink");
    expect(decodedHtml).toContain("Author-provided note");
    expect(decodedHtml).toContain("Explains the decoded action");
    expect(decodedHtml).toContain("Smartlink facts");

    const expiredPayload = encodePayload({
      s: 'return { body: "expired" }',
      notAfter: Math.floor(Date.now() / 1_000) - 1,
    });
    const expired = await worker.fetch(new Request(`${origin}/d/${expiredPayload}`), testEnv());
    expect(expired.headers.get("cache-control")).toBe("no-store");
    await expect(expired.text()).resolves.toContain("(expired)");
  });

  it("rejects a sealed blob copied to another script", async () => {
    const original = "async()=>({body:'original'})";
    const blob = await sealSecret("secret", { script: original }, pair);
    const payload = encodePayload({ s: "async()=>({body:'changed'})", k: { TOKEN: blob } });
    const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Sealed secret TOKEN could not be decrypted.",
    });
  });

  it("rejects a sealed payload whose expiry is stripped or changed", async () => {
    const source = "async()=>({body:'bound'})";
    const notAfter = Math.floor(Date.now() / 1_000) + 60 * 60;
    const blob = await sealSecret("secret", { script: source, notAfter }, pair);

    for (const tamperedNotAfter of [undefined, notAfter + 60]) {
      const payload = encodePayload({
        s: source,
        k: { TOKEN: blob },
        ...(tamperedNotAfter === undefined ? {} : { notAfter: tamperedNotAfter }),
      });
      const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Sealed secret TOKEN could not be decrypted.",
      });
    }
  });

  it("rejects a sealed payload whose author note is stripped or changed", async () => {
    const created = await createSmartlink({
      source: 'return { body: "bound" }',
      service: origin,
      interstitialNote: "Original note",
      secrets: { TOKEN: "secret" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const decoded = await decodeWorkerPayload(created.payload);

    for (const interstitialNote of [undefined, "Changed note"]) {
      const payload = encodePayload({
        ...decoded.envelope,
        ...(interstitialNote === undefined
          ? { interstitialNote: undefined }
          : { interstitialNote }),
      });
      const response = await worker.fetch(
        new Request(`${origin}/r/${payload}?__confirm=1`, { method: "POST" }),
        testEnv(),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Sealed secret TOKEN could not be decrypted.",
      });
    }
  });

  it("rejects compile-capable seals after closure or secret-name tampering", async () => {
    const created = await createSmartlink({
      source: `
        const child = async () => ({ body: ctx.secrets.CHILD_TOKEN });
        return ctx.compile(child, [], { seal: { CHILD_TOKEN: ctx.secrets.PARENT_TOKEN } });
      `,
      service: origin,
      secrets: { PARENT_TOKEN: "bound-authority" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const original = await decodeWorkerPayload(created.payload);
    const changedClosure = encodePayload({
      ...original.envelope,
      c: ["async()=>({body:'attacker-controlled'})"],
    });
    const originalBlob = original.envelope.k?.PARENT_TOKEN;
    if (!originalBlob) {
      throw new Error("Expected a sealed parent secret.");
    }
    const renamedSecret = encodePayload({
      ...original.envelope,
      k: { RENAMED_TOKEN: originalBlob },
    });

    for (const payload of [changedClosure, renamedSecret]) {
      const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv());
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("could not be decrypted"),
      });
    }
  });

  it("does not let legacy sealed links gain unauthenticated compile closures", async () => {
    const source = "async ctx=>ctx.compile(0,[])";
    const blob = await sealSecret("legacy-secret", { script: source }, pair);
    const payload = encodePayload({
      s: source,
      c: ["async()=>({body:ctx.secrets.TOKEN})"],
      k: { TOKEN: blob },
    });

    const response = await worker.fetch(new Request(`${origin}/r/${payload}`), testEnv());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Sealed compile closures require complete-artifact binding.",
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
