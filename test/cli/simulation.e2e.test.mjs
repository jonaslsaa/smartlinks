import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, withTemporaryScript } from "./helpers.mjs";

test("run simulates network calls and traces compiled children without leaking secrets", async () => {
  const source = `
await fetch(
  "https://api.example/parent?token=" + encodeURIComponent(ctx.secrets.CHILD_TOKEN!),
);
const child = async (childCtx: typeof ctx) => {
  const token = childCtx.secrets.CHILD_TOKEN!;
  const response = await fetch("https://api.example/deploy?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { authorization: "Bearer " + token, host: "ignored.example" },
    body: JSON.stringify({ token }),
  });
  let blocked = "";
  try {
    await fetch("https://runtime.example/pk");
  } catch (error) {
    blocked = String(error);
  }
  return {
    status: 202,
    headers: { "content-type": "application/json", "x-token": token },
    body: JSON.stringify({ synthetic: await response.json(), blocked, token }),
  };
};
return ctx.compile(child, [], {
  seal: { CHILD_TOKEN: ctx.params.token! },
});
`;

  await withTemporaryScript("ts", source, async (script) => {
    const secret = "top-secret";
    const parentSecret = "parent-secret";
    const result = await runCli(
      [
        "run",
        script,
        "--simulate",
        "--param",
        `token=${secret}`,
        "--secret",
        `CHILD_TOKEN=${parentSecret}`,
        "--header",
        `X-Input=${secret}`,
        "--method",
        "POST",
        "--body",
        secret,
        "--json",
      ],
      { env: { ...process.env, SMARTLINKS_URL: "https://runtime.example" } },
    );
    const report = JSON.parse(result.stdout);

    assert.equal(report.simulated, true);
    assert.deepEqual(report.inputs, {
      method: "POST",
      params: { token: ["[secret:CHILD_TOKEN]"] },
      headers: { "x-input": "[secret:CHILD_TOKEN]" },
      body: "[secret:CHILD_TOKEN]",
    });
    assert.equal(report.events[0].type, "fetch");
    assert.equal(
      report.events[0].request.url,
      "https://api.example/parent?token=[secret:CHILD_TOKEN]",
    );
    assert.equal(report.events[1].type, "compile");
    assert.equal(report.events[1].hop, 1);
    assert.deepEqual(report.events[1].artifact.sealedSecrets, ["CHILD_TOKEN"]);
    assert.equal(report.events[2].type, "fetch");
    assert.equal(
      report.events[2].request.url,
      "https://api.example/deploy?token=[secret:CHILD_TOKEN]",
    );
    assert.deepEqual(report.events[2].request.headers, {
      authorization: "Bearer [secret:CHILD_TOKEN]",
    });
    assert.equal(report.events[2].request.body, '{"token":"[secret:CHILD_TOKEN]"}');
    assert.deepEqual(report.events[2].response, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.deepEqual(report.events[3], {
      type: "fetch-blocked",
      request: { url: "https://runtime.example/pk", method: "GET" },
      reason: "Fetches to the Smartlinks runtime are blocked.",
    });
    assert.equal(report.response.status, 202);
    assert.equal(report.response.headers["x-token"], "[secret:CHILD_TOKEN]");
    assert.match(report.response.body, /\[secret:CHILD_TOKEN\]/u);
    assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));
    assert.doesNotMatch(result.stdout, new RegExp(parentSecret, "u"));
    assert.equal(result.stderr, "");
  });
});

test("run simulation redacts an exact secret used as a binary response", async () => {
  const source = "return { bodyBase64: ctx.secrets.TOKEN };\n";

  await withTemporaryScript("js", source, async (script) => {
    const secret = "c2VjcmV0";
    const result = await runCli([
      "run",
      script,
      "--simulate",
      "--secret",
      `TOKEN=${secret}`,
      "--json",
    ]);
    const report = JSON.parse(result.stdout);

    assert.equal(report.response.bodyBytes, 6);
    assert.equal(report.response.bodyRedacted, "[secret:TOKEN]");
    assert.equal("bodyBase64" in report.response, false);
    assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));
    assert.equal(result.stderr, "");
  });
});

test("run simulation replays entropy across a compiled child without repeating a value", async () => {
  const source = `
const child = async (childCtx: typeof ctx, parentRandom: string) => ({
  body: parentRandom + ":" + await childCtx.crypto.random(16),
});
return ctx.compile(child, [await ctx.crypto.random(16)]);
`;

  await withTemporaryScript("ts", source, async (script) => {
    const first = await runCli(["run", script, "--simulate", "--json"]);
    const replay = await runCli(["run", script, "--simulate", "--json"]);
    const firstReport = JSON.parse(first.stdout);
    const replayReport = JSON.parse(replay.stdout);
    const [parentRandom, childRandom] = firstReport.response.body.split(":");

    assert.equal(firstReport.response.body, replayReport.response.body);
    assert.match(parentRandom, /^[0-9a-f]{32}$/u);
    assert.match(childRandom, /^[0-9a-f]{32}$/u);
    assert.notEqual(parentRandom, childRandom);
    assert.equal(firstReport.events[0].type, "compile");
    assert.equal(first.stderr, "");
    assert.equal(replay.stderr, "");
  });
});

test("run simulation reports execution failures with a nonzero exit", async () => {
  const source = `
await fetch("https://api.example/start");
throw new Error("failed with " + ctx.secrets.API_TOKEN);
`;

  await withTemporaryScript("js", source, async (script) => {
    await assert.rejects(
      runCli(["run", script, "--simulate", "--secret", "API_TOKEN=hidden", "--json"]),
      (error) => {
        const report = JSON.parse(error.stdout);
        assert.equal(report.simulated, true);
        assert.equal(report.events[0].type, "fetch");
        assert.equal(report.error, "failed with [secret:API_TOKEN]");
        assert.doesNotMatch(error.stdout, /hidden/u);
        assert.equal(error.stderr, "");
        return true;
      },
    );
  });
});
