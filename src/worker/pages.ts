import type { DecodedPayload } from "../shared/codec.js";
import { payloadFacts } from "../shared/payload-facts.js";
import { formatStoredScript } from "../shared/script.js";
import { escapeHtml, html } from "./http.js";

const PAGE_STYLE = `
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background:#090909; color:#f3f3f3 }
  body { width:min(calc(100% - 32px), 760px); margin:48px auto; line-height:1.55 }
  h1 { font-size:30px; margin:0 0 12px; letter-spacing:-.02em } h2 { font-size:18px; margin:32px 0 10px } h3 { font-size:14px; color:#aaa } p { color:#b9b9b9 }
  pre { overflow:auto; padding:18px; border:1px solid #303030; background:#111; color:#eee; line-height:1.5 }
  button,a { color:inherit } button { border:0; border-radius:7px; background:#f3f3f3; color:#111; padding:11px 17px; font:600 15px/1.2 inherit; cursor:pointer }
  .panel { border:1px solid #303030; border-radius:9px; padding:16px 18px; background:#111; margin:20px 0 }
  .system { border-color:#5b4821; background:#17130b } .system strong { display:block; color:#f3d58b; margin-bottom:4px }
  .author-note { border-color:#34516b; background:#0d151c } .eyebrow { display:block; color:#8fbde5; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; margin-bottom:6px }
  .author-note p,.system p { margin:0 }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:8px 20px; margin:0 } dt { color:#888 } dd { margin:0; overflow-wrap:anywhere }
  form { margin-top:24px }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
`;

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${content}</body></html>`;
}

function compileClosureHtml(decoded: DecodedPayload): string {
  const closures = decoded.envelope.c ?? [];
  if (!closures.length) {
    return "";
  }
  return `<h2>Compile closures</h2>${closures
    .map(
      (closure, index) =>
        `<h3>Closure ${index}</h3><pre><code>${escapeHtml(formatStoredScript("2", closure))}</code></pre>`,
    )
    .join("")}`;
}

function authorNoteHtml(decoded: DecodedPayload): string {
  const note = decoded.envelope.interstitialNote;
  return note === undefined
    ? ""
    : `<section class="panel author-note"><span class="eyebrow">Author-provided note</span><p>${escapeHtml(note)}</p></section>`;
}

function factsHtml(decoded: DecodedPayload): string {
  const facts = payloadFacts(decoded);
  const expiry =
    facts.expiresAt === null
      ? "Does not expire"
      : `${facts.expiresAt}${facts.expired ? " (expired)" : ""}`;
  const secrets = facts.sealedSecrets.length
    ? `${facts.sealedSecrets.length}: ${facts.sealedSecrets.map(escapeHtml).join(", ")}`
    : "None";
  return `<section class="panel"><span class="eyebrow">Smartlink facts</span><dl><dt>Payload version</dt><dd>${facts.payloadVersion}</dd><dt>Expiry</dt><dd>${escapeHtml(expiry)}</dd><dt>Sealed secrets</dt><dd>${secrets}</dd><dt>Compile closures</dt><dd>${facts.compileClosures}</dd></dl></section>`;
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
  const closures = compileClosureHtml(decoded);

  return html(
    page(
      "Confirm smartlink",
      `<h1>Review before running</h1><section class="panel system"><strong>This link runs a program.</strong><p>Review its note, capabilities, and source before continuing.</p></section>${authorNoteHtml(decoded)}${factsHtml(decoded)}<h2>Source</h2><pre><code>${escapeHtml(script)}</code></pre>${closures}<form method="post" action="${escapeHtml(action)}"><button type="submit">Run this smartlink</button></form>`,
    ),
    { headers: { "cache-control": "no-store" } },
  );
}

export function decoderPage(decoded: DecodedPayload): Response {
  const script = formatStoredScript(decoded.version, decoded.envelope.s);
  const closures = compileClosureHtml(decoded);
  const notAfter = decoded.envelope.notAfter;

  return html(
    page(
      "Decode smartlink",
      `<h1>Decoded smartlink</h1>${authorNoteHtml(decoded)}${factsHtml(decoded)}<h2>Source</h2><pre><code>${escapeHtml(script)}</code></pre>${closures}<p>The encrypted secret values are intentionally not displayed.</p>`,
    ),
    {
      headers: {
        "cache-control": notAfter === undefined ? "public, max-age=300" : "no-store",
      },
    },
  );
}
