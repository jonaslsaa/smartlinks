import { describe, expect, it } from "vitest";
import {
  localRequestBody,
  lowercaseHeaders,
  userParams,
} from "../../src/shared/request-context.js";

describe("request context normalization", () => {
  it("matches production parameter and header rules for local runs", () => {
    expect(
      userParams([
        ["name", "Jonas"],
        ["__confirm", "1"],
      ]),
    ).toEqual({ name: "Jonas" });
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

  it("rejects local GET and HEAD bodies just as production omits them", () => {
    expect(localRequestBody("GET", undefined)).toBeNull();
    expect(() => localRequestBody("GET", "body")).toThrow("cannot include a body");
    expect(() => localRequestBody("HEAD", "body")).toThrow("cannot include a body");
    expect(localRequestBody("POST", "body")).toBe("body");
  });
});
