import { describe, expect, it } from "vitest";
import {
  CURRENT_PAYLOAD_VERSION,
  decodePayload,
  encodePayload,
  payloadFromInput,
} from "../../src/shared/codec.js";
import { formatStoredScript, minifyScriptBody, wrapScriptBody } from "../../src/shared/script.js";

describe("payload codec", () => {
  it("round-trips current payloads", () => {
    const envelope = { s: "async a=>a.params.to", i: true as const, k: { TOKEN: "AQID" } };
    const payload = encodePayload(envelope);

    expect(payload[0]).toBe(CURRENT_PAYLOAD_VERSION);
    expect(decodePayload(payload)).toEqual({ version: "2", envelope });
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("keeps version 1 decoding stable", () => {
    const payload = encodePayload({ s: "return 'https://example.com'" }, "1");
    expect(decodePayload(payload)).toEqual({
      version: "1",
      envelope: { s: "return 'https://example.com'" },
    });
  });

  it("extracts payloads from runner and decoder URLs", () => {
    const payload = encodePayload({ s: "async()=>{}" });
    expect(payloadFromInput(`https://run.example/r/${payload}?name=value`)).toBe(payload);
    expect(payloadFromInput(`https://run.example/d/${payload}`)).toBe(payload);
    expect(payloadFromInput(payload)).toBe(payload);
  });

  it("rejects unknown versions and corrupt data", () => {
    expect(() => decodePayload("9abc")).toThrow("Unsupported payload version");
    expect(() => decodePayload("2abc")).toThrow("invalid or corrupted");
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
});
