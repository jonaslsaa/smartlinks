const label = ctx.params.label ?? "smartlinks";
const value = ctx.params.value ?? "running";
const width = Math.max(160, (label.length + value.length) * 8 + 32);
const escapeXml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const escapedLabel = escapeXml(label);
const escapedValue = escapeXml(value);
return {
  headers: {
    "cache-control": "public, max-age=60",
    "content-type": "image/svg+xml; charset=utf-8",
  },
  body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="${escapedLabel}: ${escapedValue}"><rect width="100%" height="100%" fill="#111"/><text x="14" y="19" fill="#fff" font-family="system-ui,sans-serif" font-size="13">${escapedLabel}: ${escapedValue}</text></svg>`,
};
