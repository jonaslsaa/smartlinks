import { deflateRawSync } from "node:zlib";
import { deflateSync } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSmartlink } from "../../src/cli/build.js";
import {
  generateAuthorKeyPair,
  issueAuthorCertificate,
  signEnvelope,
  verifyAuthorProof,
} from "../../src/shared/author.js";
import { toBase64Url } from "../../src/shared/bytes.js";
import { encodePayload, MAX_DECOMPRESSED_LENGTH } from "../../src/shared/codec.js";
import {
  RUNTIME_CONTENT_SECURITY_POLICY,
  SMARTLINKS_PREVIEW_HEADER,
} from "../../src/shared/response-security.js";
import { generateKeyPair, sealSecret } from "../../src/shared/seal.js";
import { decodeWorkerPayload, inflateRawWithLimit } from "../../src/worker/codec.js";
import { exchangeGithubIdentity } from "../../src/worker/identity.js";
import worker from "../../src/worker/index.js";
import { validateWorkerScript } from "../../src/worker/sandbox.js";

const origin = "https://runtime.example";
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let authorIssuer: Awaited<ReturnType<typeof generateAuthorKeyPair>>;
let authorKey: Awaited<ReturnType<typeof generateAuthorKeyPair>>;

beforeAll(async () => {
  pair = await generateKeyPair(1);
  authorIssuer = await generateAuthorKeyPair();
  authorKey = await generateAuthorKeyPair();
});

function testEnv(
  executionRateLimiter: RateLimit = {
    limit: async () => ({ success: true }),
  },
): Env & {
  AUTHOR_CA_PRIVATE_KEY_1: string;
  PRIVATE_KEY_1: string;
  TOKEN_MASTER_SECRET: string;
} {
  return {
    ACTIVE_KEY_ID: "1",
    AUTHOR_CA_KEY_ID: "1",
    AUTHOR_CA_PRIVATE_KEY_1: authorIssuer.privateKey,
    AUTHOR_CA_PUBLIC_KEY_1: authorIssuer.publicKey as Env["AUTHOR_CA_PUBLIC_KEY_1"],
    EXECUTION_RATE_LIMITER: executionRateLimiter,
    IDENTITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
    LANDING_URL: "https://smartlinks.jonaslsa.com/",
    RUNTIME_HOSTNAMES: ["s.jonaslsa.com"],
    PRIVATE_KEY_1: pair.privateKeySecret,
    TOKEN_MASTER_SECRET: "worker-test-master-secret",
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
      source: `return {
        status: 201,
        headers: {
          "content-security-policy": "default-src *; script-src *",
          "referrer-policy": "unsafe-url",
          "x-smartlinks-preview": "1",
          "x-content-type-options": "off",
          "x-frame-options": "SAMEORIGIN",
          "x-runtime": "quickjs"
        },
        body: \`\${ctx.params.name}:\${ctx.secrets.TOKEN}\`
      }`,
      service: origin,
      secrets: { TOKEN: "sealed-value" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(`${created.link}?name=Jonas`), testEnv());

    expect(response.status).toBe(201);
    expect(response.headers.get("x-runtime")).toBe("quickjs");
    expect(response.headers.get("content-security-policy")).toBe(
      `default-src *; script-src *, ${RUNTIME_CONTENT_SECURITY_POLICY}`,
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBeNull();
    await expect(response.text()).resolves.toBe("Jonas:sealed-value");
  });

  it("hardens the runtime-owned completion page", async () => {
    const created = await createSmartlink({
      source: "const completed = true;",
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.link), testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(RUNTIME_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBeNull();
    await expect(response.text()).resolves.toContain("✓ done");
  });

  it("does not share browser cookie state between Smartlinks", async () => {
    const created = await createSmartlink({
      source: `return {
        headers: {
          "clear-site-data": "*",
          "set-cookie": "ambient=state; Path=/r/",
          "x-author": "preserved"
        },
        body: ctx.headers.cookie ?? "no cookie"
      }`,
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(
      new Request(created.link, { headers: { cookie: "ambient=state" } }),
      testEnv(),
    );

    expect(response.headers.get("clear-site-data")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-author")).toBe("preserved");
    await expect(response.text()).resolves.toBe("no cookie");
  });

  it("round-trips guest tokens across executions of the same link only", async () => {
    const source = `
      if (ctx.params.t) {
        const state = await ctx.crypto.open(ctx.params.t);
        return { body: "opened:" + state.step };
      }
      return { body: await ctx.crypto.seal({ step: 7 }) };
    `;
    const created = await createSmartlink({
      source,
      service: origin,
      publicKey: pair,
      validate: validateWorkerScript,
    });

    const sealed = await worker.fetch(new Request(created.link), testEnv());
    expect(sealed.status).toBe(200);
    const token = await sealed.text();

    const opened = await worker.fetch(new Request(`${created.link}?t=${token}`), testEnv());
    expect(opened.status).toBe(200);
    await expect(opened.text()).resolves.toBe("opened:7");

    const foreign = await createSmartlink({
      source: source.replace("opened:", "foreign:"),
      service: origin,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const rejected = await worker.fetch(new Request(`${foreign.link}?t=${token}`), testEnv());
    expect(rejected.status).toBe(422);
  });

  it("rejects a token minted by the same source with different sealed authority", async () => {
    const source = `
      if (ctx.params.action === "mint") {
        if (ctx.params.password !== ctx.secrets.PASSWORD) {
          return { status: 403, body: "denied" };
        }
        return { body: await ctx.crypto.seal({ role: "admin" }) };
      }
      const state = await ctx.crypto.open(ctx.params.token);
      return { body: "opened:" + state.role + ":" + ctx.secrets.PASSWORD };
    `;
    const victim = await createSmartlink({
      source,
      service: origin,
      secrets: { PASSWORD: "victim-pass" },
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const attacker = await createSmartlink({
      source,
      service: origin,
      secrets: { PASSWORD: "attacker-pass" },
      publicKey: pair,
      validate: validateWorkerScript,
    });

    const forged = await worker.fetch(
      new Request(`${attacker.link}?action=mint&password=attacker-pass`),
      testEnv(),
    );
    expect(forged.status).toBe(200);
    const token = await forged.text();

    const direct = await worker.fetch(
      new Request(`${victim.link}?action=mint&password=attacker-pass`),
      testEnv(),
    );
    expect(direct.status).toBe(403);

    const opened = await worker.fetch(
      new Request(`${victim.link}?action=open&token=${encodeURIComponent(token)}`),
      testEnv(),
    );
    expect(opened.status).toBe(422);
    await expect(opened.text()).resolves.not.toContain("opened:admin:victim-pass");
  });

  it("fails transparent tokens with 422 when the master secret is unset", async () => {
    const created = await createSmartlink({
      source: `return { body: await ctx.crypto.seal(1) }`,
      service: origin,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const { TOKEN_MASTER_SECRET: _unset, ...env } = testEnv();
    const response = await worker.fetch(new Request(created.link), env as Env);
    expect(response.status).toBe(422);
  });

  it("executes a link with a locally verified GitHub author certificate", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const certificate = await issueAuthorCertificate({
      authorPublicKey: authorKey.publicKey,
      identity: { githubId: 123456, githubLogin: "jonaslsaa" },
      issuerKeyId: 1,
      issuerPrivateKey: authorIssuer.privateKey,
      issuedAt: now,
      expiresAt: now + 3_600,
    });
    const created = await createSmartlink({
      source: 'return { body: "signed:" + ctx.secrets.SIGNED_TOKEN }',
      service: origin,
      interstitial: true,
      secrets: { SIGNED_TOKEN: "sealed-authority" },
      publicKey: pair,
      author: { certificate, key: authorKey },
      validate: validateWorkerScript,
    });

    const interstitial = await worker.fetch(new Request(created.link), testEnv());
    expect(interstitial.status).toBe(200);
    await expect(interstitial.text()).resolves.toContain("github.com/jonaslsaa");

    const preview = await worker.fetch(
      new Request(created.link, { headers: { "user-agent": "Slackbot-LinkExpanding" } }),
      testEnv(),
    );
    expect(preview.status).toBe(200);
    await expect(preview.text()).resolves.toContain("github.com/jonaslsaa");

    const run = await worker.fetch(
      new Request(`${created.link}?__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    expect(run.status).toBe(200);
    await expect(run.text()).resolves.toBe("signed:sealed-authority");

    const decoded = await decodeWorkerPayload(created.payload);
    const { u: _proof, ...withoutProof } = decoded.envelope;
    const downgradedPayload = encodePayload({ ...withoutProof, a: 1 });
    const downgraded = await worker.fetch(
      new Request(`${origin}/r/${downgradedPayload}?__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    expect(downgraded.status).toBe(400);

    if (!decoded.envelope.u) {
      throw new Error("Expected a signed payload.");
    }
    const [issuedCertificate, signature] = decoded.envelope.u;
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const invalidPayload = encodePayload({
      ...decoded.envelope,
      u: [issuedCertificate, tamperedSignature],
    });
    const invalidPreview = await worker.fetch(
      new Request(`${origin}/r/${invalidPayload}`, {
        headers: { "user-agent": "Slackbot-LinkExpanding" },
      }),
      testEnv(),
    );
    expect(invalidPreview.status).toBe(400);
  });

  it("exchanges an authorized device code without returning the GitHub token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "temporary-github-token" }))
      .mockResolvedValueOnce(Response.json({ id: 123456, login: "jonaslsaa" }));

    const result = await exchangeGithubIdentity({
      authorPublicKey: authorKey.publicKey,
      deviceCode: "device-code-with-enough-entropy",
      issuerKeyId: 1,
      issuerPrivateKey: authorIssuer.privateKey,
      issuerPublicKey: authorIssuer.publicKey,
      fetchImpl,
      nowSeconds: 2_000_000_000,
    });

    expect(result.status).toBe("issued");
    expect(JSON.stringify(result)).not.toContain("temporary-github-token");
    if (result.status !== "issued") {
      throw new Error("Expected an issued author certificate.");
    }
    await expect(
      verifyAuthorProof(
        {
          version: "2",
          envelope: await signEnvelope(
            "2",
            { s: 'async ctx=>({body:"signed"})' },
            result.certificate,
            authorKey,
            2_000_000_000,
          ),
        },
        { issuerPublicKeys: { 1: authorIssuer.publicKey }, nowSeconds: 2_000_000_001 },
      ),
    ).resolves.toMatchObject({ status: "valid", githubLogin: "jonaslsaa" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer temporary-github-token" }),
      }),
    );
  });

  it("preserves GitHub's device polling interval without issuing a certificate", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "authorization_pending", interval: 7 }));
    await expect(
      exchangeGithubIdentity({
        authorPublicKey: authorKey.publicKey,
        deviceCode: "device-code-with-enough-entropy",
        issuerKeyId: 1,
        issuerPrivateKey: authorIssuer.privateKey,
        issuerPublicKey: authorIssuer.publicKey,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "pending", interval: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves GitHub's slow-down signal for cumulative client backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "slow_down" }));
    await expect(
      exchangeGithubIdentity({
        authorPublicKey: authorKey.publicKey,
        deviceCode: "device-code-with-enough-entropy",
        issuerKeyId: 1,
        issuerPrivateKey: authorIssuer.privateKey,
        issuerPublicKey: authorIssuer.publicKey,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "slow_down" });
  });

  it("rate-limits certificate polling before parsing or contacting GitHub", async () => {
    const env = testEnv({ limit: async () => ({ success: true }) });
    env.IDENTITY_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const response = await worker.fetch(
      new Request(`${origin}/auth/github/certificate`, {
        method: "POST",
        body: "not-json",
      }),
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
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
        const child = async (childCtx, name) => ({
          headers: { "x-smartlinks-child": "yes" },
          body: name + ":" + childCtx.params.channel + ":" + childCtx.secrets.CHILD_TOKEN,
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

    const childRequestUrl = new URL(childUrl);
    childRequestUrl.searchParams.set("channel", "child-request");
    const child = await worker.fetch(new Request(childRequestUrl), testEnv());
    expect(child.status).toBe(200);
    expect(child.headers.get("x-smartlinks-child")).toBe("yes");
    await expect(child.text()).resolves.toBe("Jonas:child-request:delegated-value");
  });

  it("allows a child to mint another ordinary smartlink without generation metadata", async () => {
    const created = await createSmartlink({
      source: `
        const leaf = async (_leafCtx, name) => ({ body: "leaf:" + name });
        const child = async (childCtx, name) => childCtx.compile(leaf, [name]);
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

  it("executes nested inline compile closures", async () => {
    const created = await createSmartlink({
      source: `
        return ctx.compile(
          async (childCtx, name) => childCtx.compile(
            async (leafCtx, value) => ({ body: leafCtx.params.prefix + value }),
            [name],
          ),
          ["Jonas"],
        );
      `,
      service: origin,
      validate: validateWorkerScript,
    });
    const parent = await worker.fetch(new Request(created.link), testEnv());
    const child = await worker.fetch(new Request(parent.headers.get("location") ?? ""), testEnv());
    const leafUrl = new URL(child.headers.get("location") ?? "");
    leafUrl.searchParams.set("prefix", "inline:");
    const leaf = await worker.fetch(new Request(leafUrl), testEnv());

    expect(leaf.status).toBe(200);
    await expect(leaf.text()).resolves.toBe("inline:Jonas");
  });

  it("charges the single mint budget before failed compile work", async () => {
    const created = await createSmartlink({
      source: `
        const child = async (_childCtx) => ({ body: "unused" });
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
        const child = async (_childCtx, value) => ({ body: value });
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
    const calendarLink = await createSmartlink({
      source: `return { headers: { "content-type": "text/calendar" }, bodyBase64: btoa("BEGIN:VCALENDAR\\r\\nEND:VCALENDAR\\r\\n") }`,
      service: origin,
      validate: validateWorkerScript,
    });
    const calendarResponse = await worker.fetch(new Request(calendarLink.link), testEnv());

    expect(calendarResponse.headers.get("content-type")).toBe("text/calendar");
    expect(new Uint8Array(await calendarResponse.arrayBuffer())).toEqual(calendar);

    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const pngLink = await createSmartlink({
      source: `return { bodyBase64: btoa("\\x89PNG\\r\\n\\x1a\\n") }`,
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

  it("supplies host entropy in production", async () => {
    const created = await createSmartlink({
      source: `
        const first = await ctx.crypto.random(16);
        const second = await ctx.crypto.random(16, "base64");
        return { body: first + ":" + second };
      `,
      service: origin,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(new Request(created.link), testEnv());
    const [hex, base64] = (await response.text()).split(":");

    expect(hex).toMatch(/^[0-9a-f]{32}$/u);
    expect(base64).toMatch(/^[A-Za-z0-9+/]{22}==$/u);
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
    expect(reviewHtml).not.toContain('id="author-heading"');
    expect(reviewHtml).not.toContain("Unsigned");
    expect(reviewHtml).toContain("Author-provided note");
    expect(reviewHtml).toContain('aria-labelledby="author-note-heading"');
    expect(reviewHtml).toContain('aria-labelledby="facts-heading"');
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

  it("delivers a confirmed interstitial redirect as a continuation page", async () => {
    const created = await createSmartlink({
      source: 'return "https://example.com/next?a=1&note=<b>"',
      service: origin,
      interstitial: true,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const execution = await worker.fetch(
      new Request(`${created.link}?__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    expect(execution.status).toBe(200);
    expect(execution.headers.get("content-type")).toContain("text/html");
    const continuation = await execution.text();
    expect(continuation).toContain(
      'http-equiv="refresh" content="0;url=https://example.com/next?a=1&amp;note=%3Cb%3E"',
    );
    expect(continuation).toContain("Continuing");

    const plain = await createSmartlink({
      source: 'return "https://example.com/next"',
      service: origin,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const redirect = await worker.fetch(new Request(plain.link, { redirect: "manual" }), testEnv());
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://example.com/next");
  });

  it("resolves confirmed redirect targets against the request URL", async () => {
    const protocolRelative = await createSmartlink({
      source: 'return { status: 302, headers: { location: "//example.com/path" } }',
      service: origin,
      interstitial: true,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const continuation = await worker.fetch(
      new Request(`${protocolRelative.link}?__confirm=1`, { method: "POST" }),
      testEnv(),
    );
    expect(continuation.status).toBe(200);
    await expect(continuation.text()).resolves.toContain(
      'content="0;url=https://example.com/path"',
    );

    const sameOriginRelative = await createSmartlink({
      source: 'return { status: 302, headers: { location: "/somewhere/else" } }',
      service: origin,
      interstitial: true,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const passthrough = await worker.fetch(
      new Request(`${sameOriginRelative.link}?__confirm=1`, { method: "POST", redirect: "manual" }),
      testEnv(),
    );
    expect(passthrough.status).toBe(302);
    expect(passthrough.headers.get("location")).toBe("/somewhere/else");
  });

  it("rejects confirmed cross-origin redirects that preserve the POST method", async () => {
    const created = await createSmartlink({
      source: 'return { status: 307, headers: { location: "https://example.com/hook" } }',
      service: origin,
      interstitial: true,
      publicKey: pair,
      validate: validateWorkerScript,
    });
    const response = await worker.fetch(
      new Request(`${created.link}?__confirm=1`, { method: "POST", redirect: "manual" }),
      testEnv(),
    );
    expect(response.status).toBe(422);
    await expect(response.text()).resolves.toContain("Return a 303");
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
    expect(response.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBe("1");
    await expect(response.text()).resolves.toContain("Preview requests never execute it");

    const prefetch = await worker.fetch(
      new Request(`${origin}/r/${payload}`, { headers: { purpose: "prefetch" } }),
      testEnv(),
    );
    expect(prefetch.status).toBe(200);
    expect(prefetch.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBe("1");
    await expect(prefetch.text()).resolves.toContain("Preview requests never execute it");

    const head = await worker.fetch(
      new Request(`${origin}/r/${payload}`, { method: "HEAD" }),
      testEnv(),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBe("1");
    await expect(head.text()).resolves.toBe("");
  });

  it("provides a non-executing decoder page", async () => {
    const notAfter = Math.floor(Date.now() / 1_000) + 60 * 60;
    const payload = encodePayload({
      s: 'async ctx=>({body:"</code><script>entry</script>"})',
      i: true,
      c: [
        'async(ctx,name)=>({body:"first-sentinel:"+name})',
        'async()=>({body:"second-sentinel:</code><script>closure</script>"})',
      ],
      k: { RELEASE_TOKEN: "encrypted-value-must-not-render" },
      notAfter,
      interstitialNote: 'Explains <script>alert("x")</script>',
    });
    const response = await worker.fetch(new Request(`${origin}/d/${payload}`), testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const decodedHtml = await response.text();
    expect(decodedHtml).toContain("Decoded smartlink");
    expect(decodedHtml).not.toContain('id="author-heading"');
    expect(decodedHtml).not.toContain("Unsigned");
    expect(decodedHtml).toContain("Author-provided note");
    expect(decodedHtml).toContain("Explains &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(decodedHtml).toContain("Smartlink facts");
    expect(decodedHtml).toContain("<dt>Payload version</dt><dd>2</dd>");
    expect(decodedHtml).toContain("<dt>Confirmation required</dt><dd>Yes</dd>");
    expect(decodedHtml).toContain(new Date(notAfter * 1_000).toISOString());
    expect(decodedHtml).toContain("<dt>Sealed secrets</dt><dd>1: RELEASE_TOKEN</dd>");
    expect(decodedHtml).not.toContain("encrypted-value-must-not-render");
    expect(decodedHtml).toContain("<dt>Compile closures</dt><dd>2</dd>");
    const closureZero = decodedHtml.indexOf("<h3>Closure 0</h3>");
    const closureOne = decodedHtml.indexOf("<h3>Closure 1</h3>");
    const firstClosure = decodedHtml.indexOf("first-sentinel:");
    const secondClosure = decodedHtml.indexOf("second-sentinel:");
    expect(closureZero).toBeGreaterThan(-1);
    expect(closureOne).toBeGreaterThan(closureZero);
    expect(firstClosure).toBeGreaterThan(closureZero);
    expect(firstClosure).toBeLessThan(closureOne);
    expect(secondClosure).toBeGreaterThan(closureOne);
    expect(decodedHtml).toContain("&lt;/code&gt;&lt;script&gt;entry&lt;/script&gt;");
    expect(decodedHtml).toContain("&lt;/code&gt;&lt;script&gt;closure&lt;/script&gt;");
    expect(decodedHtml).not.toContain("<script>entry</script>");
    expect(decodedHtml).not.toContain("<script>closure</script>");

    const expiredPayload = encodePayload({
      s: 'return { body: "expired" }',
      notAfter: Math.floor(Date.now() / 1_000) - 1,
    });
    const expired = await worker.fetch(new Request(`${origin}/d/${expiredPayload}`), testEnv());
    expect(expired.headers.get("cache-control")).toBe("no-store");
    const expiredHtml = await expired.text();
    expect(expiredHtml).toContain("(expired)");
    expect(expiredHtml).toContain("<dt>Confirmation required</dt><dd>No</dd>");
    expect(expiredHtml).toContain("<dt>Compile closures</dt><dd>0</dd>");
    expect(expiredHtml).not.toContain("<h2>Compile closures</h2>");
    expect(expiredHtml).not.toContain("<h3>Closure");
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
        const child = async (childCtx) => ({ body: childCtx.secrets.CHILD_TOKEN });
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
