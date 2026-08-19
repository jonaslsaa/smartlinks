import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../../src/shared/bytes.js";
import {
  createCryptoOperationBudget,
  createGuestCrypto,
  type GuestTokenKeySource,
  MIN_TOKEN_KEY_BYTES,
} from "../../src/shared/guest-crypto.js";
import { payloadArtifactIdentity } from "../../src/shared/seal.js";

const MASTER = "unit-test-master-secret";
const EXPLICIT_KEY = "0123456789abcdef";

function identity(script: string, extras: Record<string, unknown> = {}): string {
  return payloadArtifactIdentity({ version: "2", envelope: { s: script, ...extras } });
}

function guest(source?: GuestTokenKeySource, maxOperations?: number) {
  return createGuestCrypto({
    crypto,
    budget: createCryptoOperationBudget(maxOperations),
    ...(source ? { tokenKeySource: source } : {}),
  });
}

function link(script = "return 1", extras: Record<string, unknown> = {}, master = MASTER) {
  return guest({
    masterSecret: master,
    artifactIdentity: identity(script, extras),
    domain: "production",
  });
}

describe("guest token seal/open", () => {
  it("round-trips JSON values with the transparent key", async () => {
    const value = { step: 2, answers: [3, 1], done: false, note: null, name: "Jonas" };
    const token = await link().seal(value);
    await expect(link().open(token)).resolves.toEqual(value);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("scopes transparent tokens to the exact artifact", async () => {
    const token = await link("return 1").seal("state");

    await expect(link("return 2").open(token)).rejects.toThrow("could not be opened");
    await expect(link("return 1", { notAfter: 2_000_000_000 }).open(token)).rejects.toThrow(
      "could not be opened",
    );
    await expect(link("return 1", { i: true }).open(token)).rejects.toThrow("could not be opened");
    await expect(link("return 1", { allowCrawlers: true }).open(token)).rejects.toThrow(
      "could not be opened",
    );
    await expect(link("return 1", { browser: { scripts: ["https"] } }).open(token)).rejects.toThrow(
      "could not be opened",
    );
    await expect(link("return 1", { cors: true }).open(token)).rejects.toThrow(
      "could not be opened",
    );
    await expect(
      link("return 1", { i: true, interstitialNote: "note" }).open(token),
    ).rejects.toThrow("could not be opened");
    await expect(link("return 1", { c: ["()=>1"] }).open(token)).rejects.toThrow(
      "could not be opened",
    );
    await expect(
      link("return 1", { a: 1, k: { PASSWORD: "different-sealed-secret" } }).open(token),
    ).rejects.toThrow("could not be opened");
    const secretToken = await link("return 1", {
      a: 1,
      k: { PASSWORD: "victim-sealed-secret" },
    }).seal("state");
    await expect(
      link("return 1", { a: 1, k: { PASSWORD: "attacker-sealed-secret" } }).open(secretToken),
    ).rejects.toThrow("could not be opened");
    expect(identity("return 1", { a: 1, k: { SECOND: "two", FIRST: "one" } })).toBe(
      identity("return 1", { a: 1, k: { FIRST: "one", SECOND: "two" } }),
    );
    await expect(link("return 1", {}, "other-master").open(token)).rejects.toThrow(
      "could not be opened",
    );
  });

  it("separates local tokens from production even when the master secret is reused", async () => {
    const artifactIdentity = identity("return 1");
    const production = guest({
      masterSecret: MASTER,
      artifactIdentity,
      domain: "production",
    });
    const local = guest({ masterSecret: MASTER, artifactIdentity, domain: "local" });
    const productionToken = await production.seal("state");
    const localToken = await local.seal("state");

    await expect(local.open(productionToken)).rejects.toThrow("could not be opened");
    await expect(production.open(localToken)).rejects.toThrow("could not be opened");

    const portableToken = await production.seal("portable", { key: EXPLICIT_KEY });
    await expect(local.open(portableToken, { key: EXPLICIT_KEY })).resolves.toBe("portable");
  });

  it("round-trips explicit-key tokens between different links", async () => {
    const token = await link("return 1").seal({ tag: "v1.2.3" }, { key: EXPLICIT_KEY });
    await expect(link("return 2").open(token, { key: EXPLICIT_KEY })).resolves.toEqual({
      tag: "v1.2.3",
    });
    await expect(guest().open(token, { key: EXPLICIT_KEY })).resolves.toEqual({ tag: "v1.2.3" });
    await expect(link("return 1").open(token)).rejects.toThrow("could not be opened");
  });

  it("rejects explicit keys under the minimum length", async () => {
    const short = "a".repeat(MIN_TOKEN_KEY_BYTES - 1);
    await expect(guest().seal("value", { key: short })).rejects.toThrow("at least 16 bytes");
    await expect(guest().seal("value", { key: "a".repeat(MIN_TOKEN_KEY_BYTES) })).resolves.toMatch(
      /^[A-Za-z0-9_-]+$/u,
    );
  });

  it("separates token domains with the context option", async () => {
    const token = await link().seal("cooldown", { context: "cooldown" });
    await expect(link().open(token, { context: "cooldown" })).resolves.toBe("cooldown");
    await expect(link().open(token, { context: "cursor" })).rejects.toThrow("could not be opened");
    await expect(link().open(token)).rejects.toThrow("could not be opened");
  });

  it("rejects tampered, truncated, foreign, and malformed tokens", async () => {
    const token = await link().seal({ answer: 42 });

    const bytes = fromBase64Url(token);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(link().open(toBase64Url(bytes))).rejects.toThrow("could not be opened");

    await expect(link().open(toBase64Url(bytes.subarray(0, 20)))).rejects.toThrow("truncated");
    await expect(link().open("not base64url!")).rejects.toThrow("base64url");

    const versioned = fromBase64Url(token);
    versioned[0] = 9;
    await expect(link().open(toBase64Url(versioned))).rejects.toThrow("unsupported version");
  });

  it("adds an optional runtime hint only to transparent-token authentication failures", async () => {
    const token = await link().seal("state");
    const hinted = createGuestCrypto({
      crypto,
      tokenKeySource: {
        masterSecret: "different-master-secret",
        artifactIdentity: identity("return 1"),
        domain: "production",
      },
      tokenOpenFailureHint: "Reuse the local token key.",
    });

    await expect(hinted.open(token)).rejects.toThrow(
      "different key or context. Reuse the local token key.",
    );
    await expect(hinted.open(token, { key: EXPLICIT_KEY })).rejects.not.toThrow(
      "Reuse the local token key.",
    );
  });

  it("requires a configured transparent key only for transparent tokens", async () => {
    await expect(guest().seal("value")).rejects.toThrow("not configured");
    await expect(guest().seal("value", { key: EXPLICIT_KEY })).resolves.toBeDefined();
  });

  it("rejects unserializable values and reports readable option errors", async () => {
    await expect(link().seal(undefined)).rejects.toThrow("JSON-serializable");
    await expect(link().seal(1, { keys: EXPLICIT_KEY } as never)).rejects.toThrow(
      "Invalid token options",
    );
    await expect(link().seal(1, { key: undefined } as never)).rejects.toThrow('omit "key"');
    await expect(link().open("")).rejects.toThrow("truncated");
  });

  it("pins the artifact canonicalization and token construction", async () => {
    expect(identity("return 1")).toBe('["2","return 1",[],null,false,null,[]]');
    const golden = guest({
      masterSecret: "golden-master",
      artifactIdentity: identity("return 1"),
      domain: "production",
    });
    await expect(
      golden.open("AVV3jLo7PH4y4aaqFFvXngcBHP7RYS4lpkrSKCltWZUr3TqnX_4ZFv_-L4o5uRBo-oI", {
        context: "golden",
      }),
    ).resolves.toEqual({ golden: true, n: 7 });
  });

  it("charges the crypto budget and enforces the input cap", async () => {
    const source = {
      masterSecret: MASTER,
      artifactIdentity: identity("return 1"),
      domain: "production" as const,
    };

    const twoOperations = guest(source, 2);
    const token = await twoOperations.seal("state");
    await expect(twoOperations.open(token)).resolves.toBe("state");
    await expect(twoOperations.seal("state")).rejects.toThrow("cryptographic operations");

    await expect(guest(source).seal("x".repeat(1_100_000))).rejects.toThrow("1 MB limit");
  });
});
