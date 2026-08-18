const response = await fetch("https://registry.npmjs.org/@jonaslsa%2Fsmartlinks/latest", {
  headers: { accept: "application/json" },
});

if (!response.ok) {
  return { status: 502, body: `npm returned HTTP ${response.status}` };
}

const data: unknown = await response.json();
if (
  typeof data !== "object" ||
  data === null ||
  !("version" in data) ||
  typeof data.version !== "string" ||
  data.version.length > 64 ||
  !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(data.version)
) {
  return { status: 502, body: "npm returned an invalid package version" };
}

const version = `v${data.version}`;
const safeVersion = version
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const width = Math.max(120, (3 + version.length) * 8 + 46);

return {
  headers: {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
  },
  body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="npm: ${safeVersion}"><rect width="100%" height="100%" fill="#0a0a0a"/><rect width="100%" height="100%" fill="none" stroke="#292929"/><text x="14" y="19" fill="#b8b8b8" font-family="ui-monospace,monospace" font-size="13">npm</text><text x="50" y="19" fill="#78f6c2" font-family="ui-monospace,monospace" font-size="13" font-weight="bold">${safeVersion}</text></svg>`,
};
