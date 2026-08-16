const DEMO_PAGE = "https://smartlinks.jonaslsa.com/demo/";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const page = (title: string, content: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{width:min(calc(100% - 48px),720px);margin:0 auto;background:#000;color:#f5f5f5;
font:16px/1.55 ui-sans-serif,system-ui,sans-serif}
header{padding:26px 0 15px;border-bottom:1px solid #292929;font-size:14px;font-weight:700}
header span{margin-left:5px;color:#858585;font:400 11px ui-monospace,monospace}
main{padding:46px 0 60px}
.eyebrow{margin-bottom:8px;color:#78f6c2;font:650 12px ui-monospace,monospace;
letter-spacing:.08em;text-transform:uppercase}
h1{margin:0 0 10px;font-size:34px;line-height:1.15;letter-spacing:-.03em}
p{max-width:640px;margin:0 0 18px;color:#b8b8b8}
label{display:block;margin:16px 0 6px;color:#b8b8b8;font-size:13px}
input,select{width:100%;max-width:520px;padding:10px 12px;border:1px solid #292929;
border-radius:0;color:#f5f5f5;background:#0a0a0a;font:inherit}
button{margin-top:20px;padding:12px 16px;border:1px solid #78f6c2;border-radius:0;
color:#03140d;background:#78f6c2;font:inherit;font-weight:700;cursor:pointer}
pre{max-width:640px;padding:14px;overflow-x:auto;border:1px solid #292929;color:#ededed;
background:#0a0a0a;font-size:13px;white-space:pre-wrap;word-break:break-all}
a{color:#f5f5f5;text-decoration:underline;text-underline-offset:3px}
footer{padding:18px 0 40px;border-top:1px solid #292929;color:#858585;font-size:12px}
</style>
</head>
<body>
<header>Smartlinks <span>[demo]</span></header>
<main>${content}</main>
<footer><a href="${DEMO_PAGE}">← All demos</a> · This page is itself a Smartlink:
swap /r/ for /d/ in the address bar to audit its source without executing it.</footer>
</body>
</html>`;

const htmlResponse = (title: string, content: string, status?: number) => ({
  status: status ?? 200,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  body: page(title, content),
});

const label = (ctx.params.label ?? "").trim();
const value = (ctx.params.value ?? "").trim();

if (!label || !value) {
  return htmlResponse(
    "Mint a badge link",
    `<p class="eyebrow">Demo 2 · Badge</p>
     <h1>Mint a live SVG badge</h1>
     <p>Pick a label and a value and this page compiles a Smartlink that serves that badge
     as an SVG image — embeddable in any HTML page. The badge has no expiry: the URL is the
     entire program, so there is nothing anywhere that needs cleaning up.</p>
     <form method="get">
       <label for="label">Label</label>
       <input id="label" name="label" required maxlength="32" placeholder="build">
       <label for="value">Value</label>
       <input id="value" name="value" required maxlength="32" placeholder="passing">
       <label for="color">Value color</label>
       <select id="color" name="color">
         <option value="mint" selected>Mint</option>
         <option value="white">White</option>
         <option value="amber">Amber</option>
         <option value="red">Red</option>
       </select>
       <button type="submit">Mint the badge</button>
     </form>`,
  );
}

if (label.length > 32 || value.length > 32) {
  return htmlResponse(
    "Too long",
    `<p class="eyebrow">Demo 2 · Badge</p>
     <h1>Keep it short</h1>
     <p>Label and value are each limited to 32 characters.</p>
     <p><a href="?">Try again</a></p>`,
    400,
  );
}

const colors: Record<string, string> = {
  mint: "#78f6c2",
  white: "#f5f5f5",
  amber: "#ffcf6e",
  red: "#ff7a7a",
};
const color = colors[ctx.params.color ?? ""] ?? colors.mint;

const child = await ctx.compile(
  async (link: SmartlinksContext, badgeLabel: string, badgeValue: string, valueColor: string) => {
    const safeLabel = escapeHtml(badgeLabel);
    const safeValue = escapeHtml(badgeValue);
    const width = Math.max(120, (badgeLabel.length + badgeValue.length) * 8 + 46);
    return {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28" role="img" aria-label="${safeLabel}: ${safeValue}"><rect width="100%" height="100%" fill="#0a0a0a"/><rect width="100%" height="100%" fill="none" stroke="#292929"/><text x="14" y="19" fill="#b8b8b8" font-family="ui-monospace,monospace" font-size="13">${safeLabel}</text><text x="${badgeLabel.length * 8 + 26}" y="19" fill="${valueColor}" font-family="ui-monospace,monospace" font-size="13" font-weight="bold">${safeValue}</text></svg>`,
    };
  },
  [label, value, color],
);

return htmlResponse(
  "Your badge is ready",
  `<p class="eyebrow">Demo 2 · Badge</p>
   <h1>Your badge exists now</h1>
   <p>The link below is a freshly compiled program that serves your
   <code>${escapeHtml(label)}: ${escapeHtml(value)}</code> badge as an SVG, forever.
   Nothing is stored anywhere — delete the URL and the badge never existed.</p>
   <pre>${escapeHtml(child)}</pre>
   <p>Embed it in any HTML page — every view executes the link and renders the SVG fresh.
   (GitHub READMEs are the one exception: GitHub proxies images through a crawler the
   runtime deliberately answers with a non-executing preview.)</p>
   <pre>&lt;img src="${escapeHtml(child)}" alt="${escapeHtml(label)}: ${escapeHtml(value)}"&gt;</pre>
   <p><a href="${escapeHtml(child)}">Open it</a> ·
   <a href="${escapeHtml(child.replace("/r/", "/d/"))}">Audit it without executing</a> ·
   <a href="?">Mint another</a></p>`,
);
