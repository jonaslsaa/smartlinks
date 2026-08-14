const incoming = JSON.parse(ctx.body ?? "{}");
const response = await ctx.fetch(ctx.secrets.SLACK_WEBHOOK_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: incoming.message ?? "Webhook received" }),
});
return response.status < 300
  ? { status: 204 }
  : { status: 502, body: `Slack returned HTTP ${response.status}` };
