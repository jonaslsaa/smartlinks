import { describe, expect, it } from "vitest";
import {
  createRequestId,
  guestRequestHeaders,
  localRequestBody,
  lowercaseHeaders,
  readBoundedRequestBody,
  userParams,
  userParamValues,
} from "../../src/shared/request-context.js";

describe("request context normalization", () => {
  it("matches production parameter and header rules for local runs", () => {
    expect(
      userParams([
        ["name", "Jonas"],
        ["__confirm", "1"],
      ]),
    ).toEqual({ name: "Jonas" });
    expect(
      userParamValues([
        ["tag", "one"],
        ["tag", "two"],
        ["constructor", "safe"],
        ["__confirm", "1"],
      ]),
    ).toEqual({ tag: ["one", "two"], constructor: ["safe"] });
    expect(lowercaseHeaders([["Content-Type", "application/json"]], true)).toEqual({
      "content-type": "application/json",
    });
    expect(
      guestRequestHeaders([
        ["Cookie", "ambient=state"],
        ["X-Test", "visible"],
      ]),
    ).toEqual({ "x-test": "visible" });
    expect(() =>
      lowercaseHeaders(
        [
          ["X-Test", "one"],
          ["x-test", "two"],
        ],
        true,
      ),
    ).toThrow("provided more than once");
  });

  it("uses a platform request ID when available and otherwise creates one", () => {
    expect(createRequestId(" ray-id ")).toBe("ray-id");
    expect(createRequestId()).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("rejects local GET and HEAD bodies just as production omits them", () => {
    expect(localRequestBody("GET", undefined)).toBeNull();
    expect(() => localRequestBody("GET", "body")).toThrow("cannot include a body");
    expect(() => localRequestBody("HEAD", "body")).toThrow("cannot include a body");
    expect(localRequestBody("POST", "body")).toBe("body");
  });

  it("bounds streamed request bodies by UTF-8 bytes", async () => {
    await expect(
      readBoundedRequestBody(new Request("https://example.com", { method: "POST", body: "€" }), 3),
    ).resolves.toBe("€");
    await expect(
      readBoundedRequestBody(new Request("https://example.com", { method: "POST", body: "€x" }), 3),
    ).rejects.toThrow("Request body exceeds");
    await expect(
      readBoundedRequestBody(
        new Request("https://example.com", {
          method: "POST",
          headers: { "content-length": "4" },
          body: "x",
        }),
        3,
      ),
    ).rejects.toThrow("Request body exceeds");
  });
});
