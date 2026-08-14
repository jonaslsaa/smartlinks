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

export function isPreviewRequest(request: Request): boolean {
  if (request.method === "HEAD") {
    return true;
  }

  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (UNFURLER_USER_AGENTS.some((agent) => userAgent.includes(agent.toLowerCase()))) {
    return true;
  }

  return [request.headers.get("sec-purpose"), request.headers.get("purpose")].some((value) =>
    value
      ?.toLowerCase()
      .split(/[,; ]+/u)
      .includes("prefetch"),
  );
}
