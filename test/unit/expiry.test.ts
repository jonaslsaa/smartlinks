import { describe, expect, it } from "vitest";
import { parseExpiry } from "../../src/cli/expiry.js";
import { formatNotAfter, isExpired } from "../../src/shared/codec.js";

const now = Date.parse("2026-08-15T12:00:00Z");
const nowSeconds = now / 1_000;

describe("link expiry", () => {
  it("parses durations relative to the build time", () => {
    expect(parseExpiry("30m", now)).toBe(nowSeconds + 30 * 60);
    expect(parseExpiry("1h", now)).toBe(nowSeconds + 60 * 60);
    expect(parseExpiry("7d", now)).toBe(nowSeconds + 7 * 24 * 60 * 60);
  });

  it("parses absolute ISO 8601 dates", () => {
    const notAfter = parseExpiry("2026-08-16T13:30:00+02:00", now);
    expect(formatNotAfter(notAfter)).toBe("2026-08-16T11:30:00.000Z");
    expect(parseExpiry("2026-08-17", now)).toBe(Date.parse("2026-08-17T00:00:00Z") / 1_000);
  });

  it("rejects past, zero, malformed, and invalid dates", () => {
    expect(() => parseExpiry("2026-08-14T12:00:00Z", now)).toThrow("future date");
    expect(() => parseExpiry("0h", now)).toThrow("future date");
    expect(() => parseExpiry("eventually", now)).toThrow("Expected a duration");
    expect(() => parseExpiry("2026-02-31", now)).toThrow("Expected a duration");
  });

  it("expires at the exact notAfter second", () => {
    expect(isExpired(nowSeconds + 1, nowSeconds)).toBe(false);
    expect(isExpired(nowSeconds, nowSeconds)).toBe(true);
    expect(isExpired(undefined, nowSeconds)).toBe(false);
  });
});
