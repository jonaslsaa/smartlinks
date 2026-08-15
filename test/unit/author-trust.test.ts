import { describe, expect, it } from "vitest";
import { trustedAuthorIssuerKeys } from "../../src/cli/author-trust.js";
import { AUTHOR_CA_PUBLIC_KEYS } from "../../src/shared/author.js";

describe("author issuer trust", () => {
  it("adds self-hosted issuers without replacing hosted issuer IDs", () => {
    expect(
      trustedAuthorIssuerKeys({ SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_128: "self-hosted-key" }),
    ).toMatchObject({ 1: AUTHOR_CA_PUBLIC_KEYS[1], 128: "self-hosted-key" });
    expect(() =>
      trustedAuthorIssuerKeys({ SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_1: "replacement-key" }),
    ).toThrow("reserved by hosted Smartlinks");
  });
});
