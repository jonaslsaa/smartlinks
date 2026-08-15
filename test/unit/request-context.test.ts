import { describe, expect, it } from "vitest";
import {
  createRequestId,
  localRequestBody,
  lowercaseHeaders,
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
});
