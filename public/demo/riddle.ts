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

const question = (ctx.params.question ?? "").trim();
const answer = (ctx.params.answer ?? "").trim();

if (!question || !answer) {
  return htmlResponse(
    "Mint a riddle link",
    `<p class="eyebrow">Demo 3 · Sealed riddle</p>
     <h1>Mint a riddle with a sealed answer</h1>
     <p>Write a question and its answer. The answer is encrypted into the new link with the
     runtime's public key — whoever holds the link can guess against it, and can even decode
     the link's full source, but the answer itself stays unreadable ciphertext.</p>
     <form method="get">
       <label for="question">Question</label>
       <input id="question" name="question" required maxlength="160"
        placeholder="What has keys but opens no locks?">
       <label for="answer">Answer (kept sealed)</label>
       <input id="answer" name="answer" required maxlength="64" placeholder="a piano">
       <button type="submit">Mint the riddle</button>
     </form>`,
  );
}

if (question.length > 160 || answer.length > 64) {
  return htmlResponse(
    "Too long",
    `<p class="eyebrow">Demo 3 · Sealed riddle</p>
     <h1>Keep it short</h1>
     <p>Questions are limited to 160 characters and answers to 64.</p>
     <p><a href="?">Try again</a></p>`,
    400,
  );
}

const child = await ctx.compile(
  async (link: SmartlinksContext, riddleQuestion: string) => {
    const sealedAnswer = link.secrets.ANSWER;
    if (!sealedAnswer) {
      return { status: 500, body: "The sealed answer is missing." };
    }
    const guess = (link.params.guess ?? "").trim().toLowerCase();
    const guessForm = `<form method="get">
       <label for="guess">Your guess</label>
       <input id="guess" name="guess" required maxlength="64">
       <button type="submit">Guess</button>
     </form>`;
    if (!guess) {
      return htmlResponse(
        "A riddle",
        `<p class="eyebrow">A sealed riddle</p>
         <h1>${escapeHtml(riddleQuestion)}</h1>
         <p>The answer travels inside this link as ciphertext. Swap /r/ for /d/ in the
         address bar: you can read every line of this program, but not the answer.</p>
         ${guessForm}`,
      );
    }
    if (guess === sealedAnswer) {
      return htmlResponse(
        "Correct",
        `<p class="eyebrow">A sealed riddle</p>
         <h1>Correct.</h1>
         <p>${escapeHtml(riddleQuestion)} — <strong>${escapeHtml(guess)}</strong>.</p>`,
      );
    }
    return htmlResponse(
      "Not it",
      `<p class="eyebrow">A sealed riddle</p>
       <h1>Not it. ${escapeHtml(riddleQuestion)}</h1>
       ${guessForm}`,
    );
  },
  [question],
  { seal: { ANSWER: answer.toLowerCase() } },
);

return htmlResponse(
  "Your riddle is ready",
  `<p class="eyebrow">Demo 3 · Sealed riddle</p>
   <h1>Your riddle exists now</h1>
   <p>The link below carries your question in plain sight and your answer as sealed
   ciphertext, bound to that exact program. Change one byte of the script and the answer
   becomes undecryptable. Share it — nobody can read the answer out of the URL, and this
   demo kept no copy.</p>
   <pre>${escapeHtml(child)}</pre>
   <p><a href="${escapeHtml(child)}">Open it</a> ·
   <a href="${escapeHtml(child.replace("/r/", "/d/"))}">Audit it without executing</a> ·
   <a href="?">Mint another</a></p>`,
);
