import { describe, expect, it } from "vitest";
import {
  corsPreflightResponse,
  RUNTIME_CONTENT_SECURITY_POLICY,
  SMARTLINKS_PREVIEW_HEADER,
} from "../../src/shared/response-security.js";
import {
  InvalidScriptResponseError,
  MAX_BINARY_RESPONSE_BYTES,
  mapScriptResult,
} from "../../src/shared/result.js";

function expectRuntimeSecurityHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toContain(
    RUNTIME_CONTENT_SECURITY_POLICY,
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

describe("script result mapping", () => {
  it("turns strings into redirects", () => {
    const response = mapScriptResult("https://example.com/path");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/path");
    expect(response.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBeNull();
    expectRuntimeSecurityHeaders(response);
  });

  it("preserves author headers without letting them weaken the runtime security floor", async () => {
    const authorPolicy = "default-src *; script-src *";
    const response = mapScriptResult({
      status: 202,
      headers: {
        "clear-site-data": '"*"',
        "content-security-policy": authorPolicy,
        "referrer-policy": "unsafe-url",
        "set-cookie": "ambient=state; Path=/r/",
        [SMARTLINKS_PREVIEW_HEADER]: "1",
        "x-content-type-options": "off",
        "x-frame-options": "SAMEORIGIN",
        "x-test": "yes",
      },
      body: "done",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(response.headers.get("clear-site-data")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe(
      `${authorPolicy}, ${RUNTIME_CONTENT_SECURITY_POLICY}`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get(SMARTLINKS_PREVIEW_HEADER)).toBeNull();
    expectRuntimeSecurityHeaders(response);
    await expect(response.text()).resolves.toBe("done");
  });

  it("applies authenticated guest browser policy while keeping the sandbox floor", () => {
    const response = mapScriptResult(
      {
        headers: {
          "access-control-allow-credentials": "true",
          "access-control-allow-origin": "https://spoofed.example",
          "content-security-policy": "img-src https://only.example",
          "referrer-policy": "unsafe-url",
          "x-frame-options": "DENY",
        },
        body: "guest",
      },
      {
        service: "https://runtime.example",
        browser: {
          images: ["https"],
          embeddableBy: ["https://host.example"],
          referrer: "origin",
        },
        cors: true,
      },
    );
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("sandbox ");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("img-src data: blob: https:");
    expect(csp).toContain("frame-ancestors https://host.example");
    expect(csp).toContain("img-src https://only.example");
    expect(response.headers.get("referrer-policy")).toBe("origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe("*");
  });

  it("keeps runtime-owned CORS headers absent without an artifact opt-in", () => {
    const response = mapScriptResult(
      {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
        },
        body: "guest",
      },
      { service: "https://runtime.example" },
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("removes browser reporting channels that could disclose the bearer URL", () => {
    const response = mapScriptResult(
      {
        headers: {
          "content-security-policy":
            "img-src https://images.example; report-uri https://reports.example/csp; report-to leaks",
          "content-security-policy-report-only":
            "script-src 'none'; report-uri https://reports.example/report-only",
          nel: '{"report_to":"leaks"}',
          "report-to": '{"group":"leaks","endpoints":[]}',
          "reporting-endpoints": 'leaks="https://reports.example/modern"',
        },
        body: "guest",
      },
      { service: "https://runtime.example" },
    );
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("img-src https://images.example");
    expect(csp).not.toMatch(/report-(?:to|uri)/u);
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("nel")).toBeNull();
    expect(response.headers.get("report-to")).toBeNull();
    expect(response.headers.get("reporting-endpoints")).toBeNull();
  });

  it("answers valid CORS preflights without creating a guest response", () => {
    const request = new Request("https://runtime.example/r/value", {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-task",
      },
    });
    const response = corsPreflightResponse(request, {
      service: "https://runtime.example",
      cors: true,
    });

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response?.headers.get("access-control-allow-headers")).toBe("content-type, x-task");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-security-policy")).toContain(
      RUNTIME_CONTENT_SECURITY_POLICY,
    );
    expect(corsPreflightResponse(request, { service: "https://runtime.example" })).toBeUndefined();
  });

  it("decodes binary response bodies without changing their bytes", async () => {
    const bytes = Uint8Array.from([0, 255, 137, 80, 78, 71, 13, 10, 26, 10]);
    const bodyBase64 = Buffer.from(bytes).toString("base64");
    const response = mapScriptResult({ status: 201, bodyBase64 });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expectRuntimeSecurityHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    const unpadded = mapScriptResult({ bodyBase64: bodyBase64.replace(/=+$/u, "") });
    expect(new Uint8Array(await unpadded.arrayBuffer())).toEqual(bytes);
  });

  it("preserves an explicit content type for binary responses", () => {
    const response = mapScriptResult({
      headers: { "content-type": "text/calendar" },
      bodyBase64: "QkVHSU46VkNBTEVOREFS",
    });

    expect(response.headers.get("content-type")).toBe("text/calendar");
  });

  it("rejects ambiguous, malformed, and oversized binary responses", () => {
    expect(() => mapScriptResult({ body: "text", bodyBase64: "dGV4dA==" })).toThrow(
      new InvalidScriptResponseError("A response cannot include both body and bodyBase64."),
    );
    for (const bodyBase64 of ["not base64", "A", "AA=", "AA===", "AB=="]) {
      expect(() => mapScriptResult({ bodyBase64 })).toThrow("bodyBase64 must be valid Base64.");
    }

    const oversized = Buffer.alloc(MAX_BINARY_RESPONSE_BYTES + 1).toString("base64");
    expect(() => mapScriptResult({ bodyBase64: oversized })).toThrow(
      "bodyBase64 exceeds the 1 MB decoded body limit.",
    );
  });

  it("returns the default done page for undefined", async () => {
    const response = mapScriptResult(undefined);
    expect(response.status).toBe(200);
    expectRuntimeSecurityHeaders(response);
    await expect(response.text()).resolves.toContain("✓ done");
  });

  it.each([204, 205, 304])("hardens bodyless status %i", (status) => {
    const response = mapScriptResult({ status, body: "ignored" });

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expectRuntimeSecurityHeaders(response);
  });

  it("rejects invalid redirects and response objects", () => {
    expect(() => mapScriptResult("javascript:alert(1)")).toThrow("http");
    expect(() => mapScriptResult({ status: 99 })).toThrow();
    expect(() => mapScriptResult({ body: 42 })).toThrow();
  });
});
