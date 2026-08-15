const release = await fetch("https://api.github.com/repos/cloudflare/workers-sdk/releases/latest", {
  headers: { accept: "application/vnd.github+json", "user-agent": "smartlinks" },
});
if (!release.ok) {
  return { status: 502, body: `GitHub returned HTTP ${release.status}` };
}
const { tag_name: tag } = await release.json();
return `https://github.com/cloudflare/workers-sdk/releases/tag/${encodeURIComponent(tag)}`;
