import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePayloadForCli } from "../../src/cli/encode.js";
import {
  CURRENT_PAYLOAD_VERSION,
  decodePayload,
  encodePayload,
  encodePayloadWith,
  MAX_SCRIPT_LENGTH,
  parseDecompressedPayload,
  parsePayloadInput,
  payloadFromInput,
  serializeEnvelope,
} from "../../src/shared/codec.js";
import { formatStoredScript, minifyScriptBody, wrapScriptBody } from "../../src/shared/script.js";

describe("payload codec", () => {
  it("round-trips current payloads", () => {
    const envelope = {
      s: "async a=>a.params.to",
      i: true as const,
      a: 1 as const,
      c: ["async value=>value"],
      k: { TOKEN: "AQID" },
      notAfter: 2_000_000_000,
      interstitialNote: "Deploys the reviewed release",
    };
    const payload = encodePayload(envelope);

    expect(payload[0]).toBe(CURRENT_PAYLOAD_VERSION);
    expect(decodePayload(payload)).toEqual({ version: "2", envelope });
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("uses a compact expiry key on the wire", () => {
    const envelope = { s: "async()=>1", notAfter: 2_000_000_000 };
    const serialized = new TextDecoder().decode(serializeEnvelope(envelope));

    expect(JSON.parse(serialized)).toEqual({ s: envelope.s, n: envelope.notAfter });
    expect(serialized).not.toContain("notAfter");
    expect(decodePayload(encodePayload(envelope)).envelope).toEqual(envelope);
  });

  it("normalizes author notes and uses a compact wire key", () => {
    const serialized = new TextDecoder().decode(
      serializeEnvelope({
        s: "async()=>1",
        i: true,
        interstitialNote: "  Deploys\n\tthe reviewed release  ",
      }),
    );

    expect(JSON.parse(serialized)).toEqual({
      s: "async()=>1",
      i: true,
      m: "Deploys the reviewed release",
    });
    expect(serialized).not.toContain("interstitialNote");
    expect(
      decodePayload(encodePayload({ s: "async()=>1", i: true, interstitialNote: "ok" })),
    ).toMatchObject({ envelope: { interstitialNote: "ok" } });
  });

  it("requires an interstitial and bounds author notes by Unicode code points", () => {
    expect(() => serializeEnvelope({ s: "async()=>1", interstitialNote: "hello" })).toThrow(
      "requires an interstitial",
    );
    expect(() =>
      serializeEnvelope({ s: "async()=>1", i: true, interstitialNote: "\u0000" }),
    ).toThrow("control characters");
    expect(() =>
      serializeEnvelope({ s: "async()=>1", i: true, interstitialNote: "🙂".repeat(141) }),
    ).toThrow("at most 140 characters");
    expect(() =>
      serializeEnvelope({ s: "async()=>1", i: true, interstitialNote: "🙂".repeat(140) }),
    ).not.toThrow();
  });

  it("decodes the previous expiry key without accepting an ambiguous expiry", () => {
    const legacy = new TextEncoder().encode(
      JSON.stringify({ s: "async()=>1", notAfter: 2_000_000_000 }),
    );

    expect(parseDecompressedPayload("2", legacy).envelope.notAfter).toBe(2_000_000_000);
    expect(() =>
      parseDecompressedPayload(
        "2",
        new TextEncoder().encode(
          JSON.stringify({ s: "async()=>1", n: 2_000_000_000, notAfter: 2_000_000_001 }),
        ),
      ),
    ).toThrow(/cannot contain both/u);
  });

  it("keeps version 1 decoding stable", () => {
    const payload = encodePayload({ s: "return 'https://example.com'" }, "1");
    expect(decodePayload(payload)).toEqual({
      version: "1",
      envelope: { s: "return 'https://example.com'" },
    });
  });

  it("decodes Node raw-DEFLATE and chooses the shortest authoring output", () => {
    const envelope = { s: 'return { body: "native zlib" }' };

    for (const version of ["1", "2"] as const) {
      const nativePayload = encodePayloadWith(
        envelope,
        [(serialized) => deflateRawSync(serialized, { level: 9 })],
        version,
      );
      const fflatePayload = encodePayload(envelope, version);
      const authoredPayload = encodePayloadForCli(envelope, version);

      expect(authoredPayload.length).toBe(Math.min(nativePayload.length, fflatePayload.length));
      expect(decodePayload(nativePayload)).toEqual({ version, envelope });
      expect(decodePayload(authoredPayload)).toEqual({
        version,
        envelope,
      });
    }
  });

  it("keeps an fflate payload when native DEFLATE crosses the URL limit", () => {
    const cases = Array.from(
      { length: 1_200 },
      (_, index) => `case"action${index}":return{body:"result${index}"};`,
    ).join("");
    const envelope = {
      s: `async a=>{switch(a.params.x){${cases}default:return{status:404}}}`,
    };
    const fflatePayload = encodePayload(envelope);

    expect(fflatePayload.length).toBeLessThan(7_800);
    expect(() =>
      encodePayloadWith(envelope, [(serialized) => deflateRawSync(serialized, { level: 9 })]),
    ).toThrow("limit is 7,800");
    expect(encodePayloadForCli(envelope)).toBe(fflatePayload);
  });

  it("extracts payloads from runner and decoder URLs", () => {
    const payload = encodePayload({ s: "async()=>{}" });
    expect(payloadFromInput(`https://run.example/r/${payload}?name=value`)).toBe(payload);
    expect(payloadFromInput(`https://run.example/d/${payload}`)).toBe(payload);
    expect(payloadFromInput(payload)).toBe(payload);
    expect(parsePayloadInput(`https://RUN.example/d/${payload}?name=value#result`)).toEqual({
      payload,
      executionUrl: `https://run.example/r/${payload}`,
    });
    expect(parsePayloadInput(payload)).toEqual({ payload });
  });

  it("rejects unknown versions and corrupt data", () => {
    expect(() => decodePayload("9abc")).toThrow("Unsupported payload version");
    expect(() => decodePayload("2abc")).toThrow("invalid or corrupted");
  });

  it("allows large compressible scripts when the encoded link fits", () => {
    const script = `async()=>"${"repeated".repeat(10_000)}"`;
    const payload = encodePayload({ s: script });

    expect(script.length).toBeGreaterThan(32_000);
    expect(decodePayload(payload).envelope.s).toBe(script);
  });

  it("round-trips escape-heavy source against the decoder's byte limit", () => {
    const script = `async()=>{/*${"\\".repeat(600_000)}*/return"ok"}`;
    const payload = encodePayload({ s: script });

    expect(payload.length).toBeLessThan(7_800);
    expect(decodePayload(payload).envelope.s).toBe(script);
  });
});

describe("script encoding", () => {
  it("minifies a function body without dropping it", async () => {
    const source = `
      const destination = ctx.params.destination ?? "https://example.com";
      return destination;
    `;
    const minified = await minifyScriptBody(source);

    expect(minified.length).toBeLessThan(wrapScriptBody(source).length);
    expect(minified).toMatch(/^async/u);
    expect(formatStoredScript("2", minified)).toContain(".params.destination");
  });

  it("keeps only a generous wrong-file input guard", () => {
    expect(() => wrapScriptBody("x".repeat(MAX_SCRIPT_LENGTH + 1))).toThrow(
      "1,000,000 character safety limit",
    );
  });
});
