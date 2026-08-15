import { type DecodedPayload, formatNotAfter, isExpired } from "../shared/codec.js";
import { formatStoredScript } from "../shared/script.js";
import { escapeHtml, html } from "./http.js";

const PAGE_STYLE = `
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background:#090909; color:#f3f3f3 }
  body { width:min(calc(100% - 32px), 760px); margin:48px auto; line-height:1.55 }
  h1 { font-size:28px; margin:0 0 12px } p { color:#b9b9b9 }
  pre { overflow:auto; padding:18px; border:1px solid #303030; background:#111; color:#eee; line-height:1.5 }
  button,a { color:inherit } button { border:1px solid #777; background:#f3f3f3; color:#111; padding:10px 16px; font:inherit; cursor:pointer }
  .warning { border-left:2px solid #d0a64b; padding:10px 14px; background:#17130b }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
`;

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${content}</body></html>`;
}

export function previewPage(head = false): Response {
  const response = html(
    page(
      "Smartlink preview",
      "<h1>Smartlink</h1><p>This URL contains a small program. Preview requests never execute it.</p>",
    ),
    { headers: { "cache-control": "no-store" } },
  );
  return head ? new Response(null, response) : response;
}

export function expiredPage(): Response {
  return html(
    page(
      "Smartlink expired",
      "<h1>This link has expired</h1><p>Its program can no longer be executed.</p>",
    ),
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}

export function interstitialPage(decoded: DecodedPayload, action: string): Response {
  const script = formatStoredScript(decoded.version, decoded.envelope.s);
  const secretNames = Object.keys(decoded.envelope.k ?? {});
  const secretText = secretNames.length
    ? `<p>Sealed secrets available to this script: <code>${secretNames.map(escapeHtml).join("</code>, <code>")}</code>.</p>`
    : "<p>This script contains no sealed secrets.</p>";

  return html(
    page(
      "Confirm smartlink",
      `<h1>Review before running</h1><p class="warning">This link will run the script shown below. Continue only if you trust where it came from and understand what it will do.</p><pre><code>${escapeHtml(script)}</code></pre>${secretText}<form method="post" action="${escapeHtml(action)}"><button type="submit">Run this smartlink</button></form>`,
    ),
    { headers: { "cache-control": "no-store" } },
  );
}

export function decoderPage(decoded: DecodedPayload): Response {
  const script = formatStoredScript(decoded.version, decoded.envelope.s);
  const secretNames = Object.keys(decoded.envelope.k ?? {});
  const notAfter = decoded.envelope.notAfter;
  const metadata = [
    `Payload version: ${decoded.version}`,
    `Confirmation required: ${decoded.envelope.i === true ? "yes" : "no"}`,
    `Sealed secrets: ${secretNames.length ? secretNames.join(", ") : "none"}`,
    `Expiry: ${notAfter === undefined ? "never" : `${formatNotAfter(notAfter)}${isExpired(notAfter) ? " (expired)" : ""}`}`,
  ];

  return html(
    page(
      "Decode smartlink",
      `<h1>Decoded smartlink</h1><p>${metadata.map(escapeHtml).join("<br>")}</p><pre><code>${escapeHtml(script)}</code></pre><p>The encrypted secret values are intentionally not displayed.</p>`,
    ),
    {
      headers: {
        "cache-control": notAfter === undefined ? "public, max-age=300" : "no-store",
      },
    },
  );
}
