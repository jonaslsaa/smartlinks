import { describe, expect, it, vi } from "vitest";
import { createNodeFetch } from "../../src/cli/node-fetch.js";
import { assertPublicUrl, createGuardedFetch } from "../../src/shared/guarded-fetch.js";

describe("guarded fetch", () => {
  it.each([
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://10.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/admin",
    "http://service.internal/admin",
    "file:///etc/passwd",
  ])("blocks %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it("allows public HTTP addresses", () => {
    expect(assertPublicUrl("https://example.com/path").href).toBe("https://example.com/path");
    expect(assertPublicUrl("https://8.8.8.8/").hostname).toBe("8.8.8.8");
  });

  it("validates redirects and strips adjacent infrastructure headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
      const url = request instanceof Request ? request.url : request.toString();
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "/done" } });
      }
      const headers = new Headers(init?.headers);
      return Response.json({
        connection: headers.get("connection"),
        contentLength: headers.get("content-length"),
        forwarded: headers.get("x-forwarded-for"),
        host: headers.get("host"),
        token: headers.get("authorization"),
      });
    });
    const guarded = createGuardedFetch({ fetchImpl });

    const response = await guarded("https://example.com/start", {
      headers: {
        authorization: "Bearer token",
        connection: "keep-alive",
        "content-length": "10",
        host: "evil.test",
        "x-forwarded-for": "127.0.0.1",
      },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      connection: null,
      contentLength: null,
      forwarded: null,
      host: null,
      token: "Bearer token",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("blocks redirects to private addresses", async () => {
    const guarded = createGuardedFetch({
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    });
    await expect(guarded("https://example.com")).rejects.toThrow("private");
  });

  it("blocks cross-origin redirects before credentials or bodies can be forwarded", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 307, headers: { location: "https://attacker.example/" } }),
    );
    const guarded = createGuardedFetch({ fetchImpl });

    await expect(
      guarded("https://api.example/start", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: "sealed input",
      }),
    ).rejects.toThrow("Cross-origin");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns 304 responses normally and applies POST-to-303 redirect semantics", async () => {
    const notModified = createGuardedFetch({
      fetchImpl: async () => new Response(null, { status: 304 }),
    });
    await expect(notModified("https://example.com/cache")).resolves.toMatchObject({ status: 304 });

    const fetchImpl = vi.fn<typeof fetch>(async (_request, init) => {
      if (fetchImpl.mock.calls.length === 1) {
        return new Response(null, { status: 303, headers: { location: "/result" } });
      }
      return Response.json({
        body: init?.body ?? null,
        contentType: new Headers(init?.headers).get("content-type"),
        method: init?.method,
      });
    });
    const guarded = createGuardedFetch({ fetchImpl });
    const result = await guarded("https://example.com/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(JSON.parse(result.text)).toEqual({ body: null, contentType: null, method: "GET" });
  });

  it("measures request bodies and headers as UTF-8 bytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const guarded = createGuardedFetch({ fetchImpl });

    await expect(
      guarded("https://example.com", { method: "POST", body: "€".repeat(400_000) }),
    ).rejects.toThrow("1 MB");
    await expect(
      guarded("https://example.com", { headers: { "x-large": "é".repeat(8_192) } }),
    ).rejects.toThrow("16 KB");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects DNS hostnames that resolve to private addresses in the Node CLI", async () => {
    const fetchImpl = createNodeFetch(async () => [{ address: "127.0.0.1", family: 4 }]);
    const guarded = createGuardedFetch({ fetchImpl });

    await expect(guarded("https://public-looking.example/")).rejects.toThrow("private");
  });

  it("enforces the response and request-count limits", async () => {
    const tooLarge = createGuardedFetch({
      fetchImpl: async () => new Response("x".repeat(1_048_577)),
    });
    await expect(tooLarge("https://example.com")).rejects.toThrow("1 MB");

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const guarded = createGuardedFetch({ fetchImpl, maxFetches: 1 });
    await guarded("https://example.com");
    await expect(guarded("https://example.com")).rejects.toThrow("at most 1");
  });
});
