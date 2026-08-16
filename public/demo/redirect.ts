const DEMO_PAGE = "https://smartlinks.jonaslsa.com/demo/";
const MIN_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 86400;

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

const target = (ctx.params.target ?? "").trim();

if (!target) {
  return htmlResponse(
    "Mint a redirect link",
    `<p class="eyebrow">Demo 1 · Redirect</p>
     <h1>Mint a redirect link</h1>
     <p>Enter any URL and this page compiles a brand-new Smartlink that redirects to it.
     The new link is a self-contained program: nothing is stored anywhere, and it expires
     when you decide.</p>
     <form method="get">
       <label for="target">Destination URL</label>
       <input id="target" name="target" type="url" required maxlength="2000"
        placeholder="https://example.com">
       <label for="ttl">Link lifetime</label>
       <select id="ttl" name="ttl">
         <option value="900">15 minutes</option>
         <option value="3600" selected>1 hour</option>
         <option value="21600">6 hours</option>
         <option value="86400">24 hours</option>
       </select>
       <button type="submit">Mint the link</button>
     </form>`,
  );
}

if (!/^https?:\/\/\S+$/i.test(target) || target.length > 2000) {
  return htmlResponse(
    "Invalid URL",
    `<p class="eyebrow">Demo 1 · Redirect</p>
     <h1>That does not look like a URL</h1>
     <p>The destination must be an absolute http(s) URL of at most 2,000 characters.</p>
     <p><a href="?">Try again</a></p>`,
    400,
  );
}

const requestedTtl = Number(ctx.params.ttl ?? "");
const ttlSeconds = Number.isInteger(requestedTtl)
  ? Math.min(Math.max(requestedTtl, MIN_TTL_SECONDS), MAX_TTL_SECONDS)
  : 3600;

const child = await ctx.compile(
  async (link: SmartlinksContext, url: string) => url,
  [target],
  {
    ttlSeconds,
    note: "Minted by the Smartlinks demo: redirects to a URL a visitor chose.",
  },
);

const hours = ttlSeconds / 3600;
const lifetime = ttlSeconds < 3600 ? `${ttlSeconds / 60} minutes` : hours === 1 ? "1 hour" : `${hours} hours`;

return htmlResponse(
  "Your link is ready",
  `<p class="eyebrow">Demo 1 · Redirect</p>
   <h1>Your link exists now</h1>
   <p>A new program was compiled, sealed, and encoded into the URL below — while this
   page rendered. It redirects to <code>${escapeHtml(target)}</code> for ${lifetime},
   behind a confirmation page, then dies. No server remembers it; the URL is the program.</p>
   <pre>${escapeHtml(child)}</pre>
   <p><a href="${escapeHtml(child)}">Open it</a> ·
   <a href="${escapeHtml(child.replace("/r/", "/d/"))}">Audit it without executing</a> ·
   <a href="?">Mint another</a></p>`,
);
