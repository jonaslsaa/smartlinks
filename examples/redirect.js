const release = await ctx.fetch("https://api.github.com/repos/cloudflare/workers-sdk/releases/latest", {
  headers: { accept: "application/vnd.github+json", "user-agent": "smartlinks" },
});
const tag = JSON.parse(release.text).tag_name;
return `https://github.com/cloudflare/workers-sdk/releases/tag/${encodeURIComponent(tag)}`;
