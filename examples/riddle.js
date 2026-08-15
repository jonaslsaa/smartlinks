// Create: ?answer=<secret>  →  returns a shareable ?a=<sealed>&guess= URL fragment.
// The sealed answer travels inside the link itself, checkable but unreadable.
if (ctx.params.answer) {
  const sealed = await ctx.crypto.seal(ctx.params.answer.trim().toLowerCase(), {
    context: "riddle",
  });
  return { body: `Share your riddle with ?a=${sealed}&guess=` };
}
if (!ctx.params.a) {
  return { status: 400, body: "Create a riddle with ?answer=<secret>." };
}
const answer = await ctx.crypto.open(ctx.params.a, { context: "riddle" });
const guess = (ctx.params.guess ?? "").trim().toLowerCase();
if (!guess) {
  return { body: "Add your guess with &guess=<word>." };
}
return { body: guess === answer ? "Correct!" : "Not it. Try again." };
