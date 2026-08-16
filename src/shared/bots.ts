const UNFURLER_USER_AGENTS = [
  "Slackbot-LinkExpanding",
  "Discordbot",
  "Twitterbot",
  "facebookexternalhit",
  "github-camo",
  "WhatsApp",
  "LinkedInBot",
  "TelegramBot",
  "Googlebot",
  "bingbot",
] as const;

export function isPreviewRequest(request: Request, allowCrawlers = false): boolean {
  if (request.method === "HEAD") {
    return true;
  }

  const isPrefetch = [request.headers.get("sec-purpose"), request.headers.get("purpose")].some(
    (value) =>
      value
        ?.toLowerCase()
        .split(/[,; ]+/u)
        .includes("prefetch"),
  );
  if (isPrefetch) {
    return true;
  }

  return isCrawlerRequest(request) && !(allowCrawlers && request.method === "GET");
}

export function isCrawlerRequest(request: Request): boolean {
  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  return UNFURLER_USER_AGENTS.some((agent) => userAgent.includes(agent.toLowerCase()));
}
