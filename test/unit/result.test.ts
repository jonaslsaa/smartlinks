import { describe, expect, it } from "vitest";
import { mapScriptResult } from "../../src/shared/result.js";

describe("script result mapping", () => {
  it("turns strings into redirects", () => {
    const response = mapScriptResult("https://example.com/path");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/path");
  });

  it("turns literal results into responses", async () => {
    const response = mapScriptResult({ status: 202, headers: { "x-test": "yes" }, body: "done" });
    expect(response.status).toBe(202);
    expect(response.headers.get("x-test")).toBe("yes");
    await expect(response.text()).resolves.toBe("done");
  });

  it("returns the default done page for undefined", async () => {
    const response = mapScriptResult(undefined);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("✓ done");
  });

  it("rejects invalid redirects and response objects", () => {
    expect(() => mapScriptResult("javascript:alert(1)")).toThrow("http");
    expect(() => mapScriptResult({ status: 99 })).toThrow();
    expect(() => mapScriptResult({ body: 42 })).toThrow();
  });
});
