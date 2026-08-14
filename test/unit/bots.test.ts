import { describe, expect, it } from "vitest";
import { isPreviewRequest } from "../../src/shared/bots.js";

describe("preview request detection", () => {
  it.each([
    "Slackbot-LinkExpanding 1.0",
    "Discordbot/2.0",
    "Twitterbot",
    "facebookexternalhit/1.1",
    "github-camo",
    "WhatsApp/2.0",
    "LinkedInBot",
    "TelegramBot",
    "Googlebot",
    "bingbot",
  ])("blocks the %s unfurler", (userAgent) => {
    expect(
      isPreviewRequest(
        new Request("https://example.com/r/link", { headers: { "user-agent": userAgent } }),
      ),
    ).toBe(true);
  });

  it("blocks HEAD and explicit prefetch requests", () => {
    expect(isPreviewRequest(new Request("https://example.com", { method: "HEAD" }))).toBe(true);
    expect(
      isPreviewRequest(
        new Request("https://example.com", { headers: { "sec-purpose": "prefetch" } }),
      ),
    ).toBe(true);
  });

  it("does not require browser-only headers", () => {
    expect(isPreviewRequest(new Request("https://example.com"))).toBe(false);
  });
});
