import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { runCli, withTemporaryScript } from "./helpers.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const runtimeContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

function assertRuntimeSecurityHeaders(headers) {
  const get = (name) =>
    typeof headers.get === "function" ? headers.get(name) : (headers[name] ?? null);
  assert.ok(get("content-security-policy")?.includes(runtimeContentSecurityPolicy));
  assert.equal(get("referrer-policy"), "no-referrer");
  assert.equal(get("x-content-type-options"), "nosniff");
  assert.equal(get("x-frame-options"), "DENY");
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startServe(script, args = [], options = {}) {
  const child = spawn(process.execPath, [cli, "run", script, "--serve", "--port", "0", ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Serve mode did not start. stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    const inspectOutput = () => {
      const match = stdout.match(/ at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (!match?.[1]) {
        return;
      }
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.stdout.off("data", inspectOutput);
      resolve(match[1]);
    };
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Serve mode exited before listening (${code ?? signal}). stdout=${stdout} stderr=${stderr}`,
        ),
      );
    };
    child.once("exit", onExit);
    child.stdout.on("data", inspectOutput);
    inspectOutput();
  });

  return {
    child,
    origin,
    output: () => ({ stdout, stderr }),
  };
}

async function stopServe(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    return;
  }
  const stopped = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  await stopped;
}

async function requestWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode,
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

test("the built CLI exposes its version and public subcommands", async () => {
  const version = await runCli(["--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runCli(["--help"]);
  for (const command of ["build", "decode", "run", "login", "logout", "whoami"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(help.stdout, /\b(?:author-)?keygen\b/u);

  const buildHelp = await runCli(["help", "build"]);
  assert.doesNotMatch(buildHelp.stdout, /--service\b/u);
  assert.match(buildHelp.stdout, /--no-type-check\b/u);
  assert.match(buildHelp.stdout, /--expires <duration-or-date>/u);
  assert.match(buildHelp.stdout, /--interstitial-note <text>/u);
  assert.match(buildHelp.stdout, /--sign\s+sign with the author identity/u);
  assert.match(buildHelp.stdout, /--copy\s+copy the link and print a fingerprint receipt/u);
  assert.match(
    buildHelp.stdout,
    /--out <file>\s+write the link privately and print a\s+fingerprint receipt/u,
  );

  const runHelp = await runCli(["help", "run"]);
  assert.match(runHelp.stdout, /--no-type-check\b/u);
  assert.match(runHelp.stdout, /--serve\b/u);
  assert.match(runHelp.stdout, /--port <number>/u);
  assert.match(runHelp.stdout, /--simulate\b/u);
});

test("keygen emits a usable key pair for the requested key ID", async () => {
  const result = await runCli(["keygen", "--key-id", "7", "--json"]);
  const key = JSON.parse(result.stdout);

  assert.equal(key.keyId, 7);
  assert.match(key.publicKey, /^[A-Za-z0-9_-]+$/u);
  assert.match(key.privateKeySecret, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(key.privateKeySecret.split(".")[1], key.publicKey);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/u);
});

test("run passes request values and secrets through the production sandbox", async () => {
  const source = `
const signature = await ctx.crypto.hmacSha256("key", "message");
const received: Record<string, unknown> = {
  params: ctx.params,
  paramValues: ctx.paramValues,
  method: ctx.method,
  headers: ctx.headers,
  body: ctx.body,
  secret: ctx.secrets.E2E_TOKEN,
  requestId: ctx.requestId,
  cryptoVerified: await ctx.crypto.verifyHmacSha256("key", "message", signature),
};

return {
  status: 201,
  headers: {
    "clear-site-data": "*",
    "content-type": "application/json",
    "set-cookie": "ambient=state; Path=/r/",
    "x-smartlinks-preview": "1",
    "x-smartlinks-e2e": "run",
  },
  body: JSON.stringify(received),
};
`;

  await withTemporaryScript("ts", source, async (script) => {
    const result = await runCli([
      "run",
      script,
      "--param",
      "name=CLI",
      "--param",
      "mode=e2e",
      "--param",
      "tag=one",
      "--param",
      "tag=two",
      "--secret",
      "E2E_TOKEN=sealed",
      "--header",
      "X-Trace=trace-123",
      "--header",
      "Cookie=ambient-state",
      "--method",
      "post",
      "--body",
      '{"ok":true}',
      "--json",
    ]);
    const response = JSON.parse(result.stdout);

    assert.equal(response.status, 201);
    assert.equal(response.headers["clear-site-data"], undefined);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers["x-smartlinks-preview"], undefined);
    assert.equal(response.headers["x-smartlinks-e2e"], "run");
    assertRuntimeSecurityHeaders(response.headers);
    const received = JSON.parse(response.body);
    assert.match(received.requestId, /^[0-9a-f-]{36}$/u);
    delete received.requestId;
    assert.deepEqual(received, {
      params: { name: "CLI", mode: "e2e", tag: "two" },
      paramValues: { name: ["CLI"], mode: ["e2e"], tag: ["one", "two"] },
      method: "POST",
      headers: { "x-trace": "trace-123" },
      body: '{"ok":true}',
      secret: "sealed",
      cryptoVerified: true,
    });
  });
});

test("run blocks fetches to the configured runtime before using the network", async () => {
  const source = `
try {
  await fetch("https://runtime.example/r/payload");
  return { body: "unexpected success" };
} catch (error) {
  return { body: String(error) };
}
`;

  await withTemporaryScript("js", source, async (script) => {
    const result = await runCli(["run", script, "--allow-network", "--json"], {
      env: { ...process.env, SMARTLINKS_URL: "https://runtime.example" },
    });
    const response = JSON.parse(result.stdout);

    assert.equal(response.status, 200);
    assert.match(response.body, /Fetches to the Smartlinks runtime are blocked\./u);
    assert.equal(result.stderr, "");
  });
});

test("run locally executes a sealed child with typed tuple arguments", async () => {
  const source = `
const leaf = async (leafCtx: typeof ctx, name: string) => ({
  body: name + ":" + leafCtx.secrets.CHILD_TOKEN,
});
const child = async (childCtx: typeof ctx, name: string) => childCtx.compile(leaf, [name], {
  seal: { CHILD_TOKEN: childCtx.secrets.CHILD_TOKEN! },
});
return ctx.compile(child, [ctx.params.name ?? "world"], {
  seal: { CHILD_TOKEN: ctx.secrets.PARENT_TOKEN! },
  ttlSeconds: 60,
});
`;

  await withTemporaryScript("ts", source, async (script) => {
    const result = await runCli([
      "run",
      script,
      "--param",
      "name=Jonas",
      "--secret",
      "PARENT_TOKEN=local-secret",
      "--json",
    ]);
    const response = JSON.parse(result.stdout);

    assert.equal(response.status, 200);
    assert.equal(response.body, "Jonas:local-secret");
    assert.equal(response.headers.location, undefined);
    assert.equal(result.stderr, "");
  });
});

test("run preserves calendar and PNG response bytes", async () => {
  const fixtures = [
    {
      name: "calendar",
      bytes: Buffer.from("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
      headers: { "content-type": "text/calendar" },
    },
    {
      name: "png",
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      headers: undefined,
    },
  ];

  for (const fixture of fixtures) {
    const bodyBase64 = fixture.bytes.toString("base64");
    const source = `
return {
  ${fixture.headers ? `headers: ${JSON.stringify(fixture.headers)},` : ""}
  bodyBase64: ${JSON.stringify(bodyBase64)},
};
`;

    await withTemporaryScript("ts", source, async (script) => {
      const jsonResult = await runCli(["run", script, "--json"]);
      const output = JSON.parse(jsonResult.stdout);

      assert.equal(output.bodyBase64, bodyBase64, fixture.name);
      assert.equal(
        output.headers["content-type"],
        fixture.headers?.["content-type"] ?? "application/octet-stream",
        fixture.name,
      );
      assert.equal("body" in output, false, fixture.name);

      const rawResult = await runCli(["run", script], { encoding: "buffer" });
      assert.deepEqual(rawResult.stdout, fixture.bytes, fixture.name);
      assert.match(rawResult.stderr.toString(), /HTTP 200/u);
    });
  }
});

test("run --serve refreshes the production sandbox from real browser requests", async () => {
  const firstSource = `
return {
  status: 201,
  headers: {
    "content-security-policy": "img-src https://images.example",
    "content-type": "application/json",
    "referrer-policy": "unsafe-url",
    "x-content-type-options": "off",
    "x-frame-options": "SAMEORIGIN",
    "x-smartlinks-serve": "yes",
  },
  body: JSON.stringify({
    params: ctx.params,
    paramValues: ctx.paramValues,
    method: ctx.method,
    trace: ctx.headers["x-trace"],
    body: ctx.body,
    secret: ctx.secrets.LOCAL_TOKEN,
  }),
};
`;

  await withTemporaryScript("ts", firstSource, async (script) => {
    const server = await startServe(script, ["--secret", "LOCAL_TOKEN=local-secret"], {
      env: { SMARTLINKS_URL: "http://127.0.0.1:1" },
    });
    try {
      const first = await fetch(`${server.origin}/?tag=one&tag=two&__confirm=1`, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-trace": "browser-request" },
        body: "hello",
      });
      assert.equal(first.status, 201);
      assert.equal(first.headers.get("x-smartlinks-serve"), "yes");
      assert.ok(
        first.headers.get("content-security-policy")?.includes("img-src https://images.example"),
      );
      assertRuntimeSecurityHeaders(first.headers);
      assert.deepEqual(await first.json(), {
        params: { tag: "two" },
        paramValues: { tag: ["one", "two"] },
        method: "POST",
        trace: "browser-request",
        body: "hello",
        secret: "local-secret",
      });

      const oversized = await fetch(server.origin, {
        method: "POST",
        body: "x".repeat(1_048_577),
      });
      assert.equal(oversized.status, 413);
      assert.match((await oversized.json()).error, /Request body exceeds/u);

      const favicon = await fetch(`${server.origin}/favicon.ico`);
      assert.equal(favicon.status, 204);

      const missing = await fetch(`${server.origin}/asset.css`);
      assert.equal(missing.status, 404);

      const crossSite = await fetch(server.origin, {
        headers: { accept: "text/html", origin: "https://attacker.example" },
      });
      assert.equal(crossSite.status, 403);
      assert.match(await crossSite.text(), /Cross-origin requests are not allowed/u);

      for (const fetchSite of ["same-site", "cross-site"]) {
        const blocked = await requestWithHeaders(server.origin, {
          accept: "text/html",
          "sec-fetch-site": fetchSite,
        });
        assert.equal(blocked.status, 403, fetchSite);
        assert.match(blocked.body, /Cross-site requests are not allowed/u, fetchSite);
      }

      const wrongHost = await requestWithHeaders(server.origin, { host: "attacker.example" });
      assert.equal(wrongHost.status, 400);
      assert.match(wrongHost.body, /Host header does not match/u);

      await writeFile(script, 'const value: number = "wrong";\nreturn { body: value };\n');
      const typeError = await fetch(server.origin, { headers: { accept: "text/html" } });
      assert.equal(typeError.status, 422);
      const typeErrorBody = await typeError.text();
      assert.match(typeErrorBody, /Local Smartlinks preview/u);
      assert.match(typeErrorBody, /Could not type-check/u);

      const html = "<!doctype html><title>Edited</title><h1>Saved</h1>";
      await writeFile(
        script,
        `return { headers: { "content-type": "text/html" }, body: ${JSON.stringify(html)} };\n`,
      );
      const edited = await fetch(server.origin);
      assert.equal(edited.status, 200);
      assert.equal(await edited.text(), html);

      await writeFile(script, 'return "https://example.com/next";\n');
      const redirect = await fetch(server.origin, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get("location"), "https://example.com/next");
      assertRuntimeSecurityHeaders(redirect.headers);

      await writeFile(
        script,
        'await fetch("https://example.com");\nreturn { body: "unreachable" };\n',
      );
      const networkBlocked = await fetch(server.origin);
      assert.equal(networkBlocked.status, 422);
      assert.match((await networkBlocked.json()).error, /Network access is disabled/u);

      await writeFile(script, 'throw new Error("HEAD must not execute");\n');
      const head = await fetch(server.origin, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("x-smartlinks-preview"), "1");
      assert.equal(await head.text(), "");

      const prefetch = await fetch(server.origin, { headers: { purpose: "prefetch" } });
      assert.equal(prefetch.status, 200);
      assert.equal(prefetch.headers.get("x-smartlinks-preview"), "1");
      assert.equal(await prefetch.text(), "");

      await writeFile(script, "const completed = true;\n");
      const defaultPage = await fetch(server.origin, { headers: { accept: "text/html" } });
      assert.equal(defaultPage.status, 200);
      assert.equal(defaultPage.headers.get("x-smartlinks-preview"), null);
      assertRuntimeSecurityHeaders(defaultPage.headers);
      assert.match(await defaultPage.text(), /Local Smartlinks preview/u);

      await writeFile(
        script,
        'const child = async (_childCtx: typeof ctx, name: string) => ({ body: "compiled:" + name });\nreturn ctx.compile(child, [ctx.params.name ?? "world"]);\n',
      );
      const compiled = await fetch(`${server.origin}/?name=Browser`);
      assert.equal(compiled.status, 200);
      assert.equal(await compiled.text(), "compiled:Browser");

      const binary = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      await writeFile(
        script,
        `return { bodyBase64: ${JSON.stringify(binary.toString("base64"))} };\n`,
      );
      const binaryResponse = await fetch(server.origin);
      assert.equal(binaryResponse.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(Buffer.from(await binaryResponse.arrayBuffer()), binary);
    } finally {
      await stopServe(server);
    }
  });
});

test("run --serve rejects one-shot request flags", async () => {
  await assert.rejects(
    runCli(["run", "missing.ts", "--serve", "--param", "name=value"]),
    (error) => {
      assert.match(
        error.stderr,
        /option '-p, --param <NAME=value>' cannot be used with option '--serve'/u,
      );
      return true;
    },
  );
  await assert.rejects(runCli(["run", "missing.ts", "--serve", "--port", "65536"]), (error) => {
    assert.match(error.stderr, /port must be an integer from 0 to 65535/u);
    return true;
  });
  await assert.rejects(runCli(["run", "missing.ts", "--serve", "--simulate"]), (error) => {
    assert.match(error.stderr, /option '--simulate' cannot be used with option '--serve'/u);
    return true;
  });
  await assert.rejects(runCli(["run", "missing.ts", "--allow-network", "--simulate"]), (error) => {
    assert.match(error.stderr, /option '--allow-network' cannot be used with option '--simulate'/u);
    return true;
  });
});

test("build output round-trips through decode as a URL and raw payload", async () => {
  const keyResult = await runCli(["keygen", "--key-id", "9", "--json"]);
  const key = JSON.parse(keyResult.stdout);
  let publicKeyRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/pk") {
      publicKeyRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keyId: key.keyId, publicKey: key.publicKey }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const service = await listen(server);

  try {
    await withTemporaryScript(
      "js",
      `const firstChild = async (childCtx, label) => ({ body: "first-sentinel:" + label + ":" + (childCtx.params.name ?? "") });
const secondChild = async (_childCtx, label) => ({ body: "second-sentinel:" + label });
if (ctx.params.child === "1") return ctx.compile(firstChild, ["fixed"]);
if (ctx.params.child === "2") return ctx.compile(secondChild, ["fixed"]);
const name = ctx.params.name ?? "world";
return "https://example.com/" + name;
`,
      async (script) => {
        const defaultEnvironment = { ...process.env };
        delete defaultEnvironment.SMARTLINKS_URL;
        const defaultBuild = JSON.parse(
          (await runCli(["build", script, "--json"], { env: defaultEnvironment })).stdout,
        );
        assert.match(defaultBuild.link, /^https:\/\/s\.jonaslsa\.com\/r\/2/u);

        const built = JSON.parse(
          (
            await runCli(
              [
                "build",
                script,
                "--secret",
                "E2E_TOKEN=value",
                "--interstitial-note",
                "  Deploys\n the reviewed release  ",
                "--expires",
                "2100-01-01T00:00:00Z",
                "--no-minify",
                "--json",
              ],
              { env: { ...process.env, SMARTLINKS_URL: service } },
            )
          ).stdout,
        );

        assert.match(built.link, new RegExp(`^${service}/r/2`));
        assert.equal("decoder" in built, false);
        assert.equal("fingerprint" in built, false);
        assert.equal(built.payloadVersion, 2);
        assert.equal(built.notAfter, Date.parse("2100-01-01T00:00:00Z") / 1000);
        assert.equal(built.expiresAt, "2100-01-01T00:00:00.000Z");
        assert.equal(built.expired, false);
        assert.equal(built.interstitialNote, "Deploys the reviewed release");
        assert.equal(built.characters, built.link.length);
        assert.equal(built.fits, true);
        assert.equal(typeof built.payloadCharacters, "number");
        assert.equal(typeof built.budgetPercent, "number");
        assert.equal(publicKeyRequests, 1);

        const decodedFromUrl = JSON.parse((await runCli(["decode", built.link, "--json"])).stdout);
        assert.equal(decodedFromUrl.payloadVersion, 2);
        assert.equal(decodedFromUrl.interstitial, true);
        assert.equal(decodedFromUrl.compileClosures, 2);
        assert.equal(decodedFromUrl.closures.length, 2);
        assert.match(decodedFromUrl.closures[0], /first-sentinel/u);
        assert.match(decodedFromUrl.closures[1], /second-sentinel/u);
        assert.deepEqual(decodedFromUrl.sealedSecrets, ["E2E_TOKEN"]);
        assert.equal(decodedFromUrl.notAfter, built.notAfter);
        assert.equal(decodedFromUrl.expiresAt, built.expiresAt);
        assert.equal(decodedFromUrl.expired, false);
        assert.equal(decodedFromUrl.interstitialNote, built.interstitialNote);
        assert.match(decodedFromUrl.script, /ctx\.params\.name/u);

        const payload = new URL(built.link).pathname.slice("/r/".length);
        const decodedFromPayload = JSON.parse((await runCli(["decode", payload, "--json"])).stdout);
        assert.deepEqual(decodedFromPayload, decodedFromUrl);
      },
    );
  } finally {
    await close(server);
  }
});

test("build writes the link as an artifact without repeating it", async () => {
  await withTemporaryScript(
    "ts",
    'const name = ctx.params.name ?? "world";\nreturn { body: name };\n',
    async (script) => {
      const source = await readFile(script, "utf8");
      await assert.rejects(runCli(["build", script, "--out", script]), (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /must not overwrite the input script/u);
        return true;
      });
      assert.equal(await readFile(script, "utf8"), source);

      const output = join(dirname(script), "link.txt");
      const result = await runCli([
        "build",
        script,
        "--expires",
        "2100-01-01T00:00:00Z",
        "--out",
        output,
      ]);
      const link = await readFile(output, "utf8");
      const expectedFingerprint = fingerprint(link);

      assert.match(link, /^https:\/\/s\.jonaslsa\.com\/r\/2/u);
      assert.doesNotMatch(link, /\n/u);
      assert.doesNotMatch(result.stdout, /https:\/\//u);
      assert.match(
        result.stdout,
        new RegExp(
          `^${link.length.toLocaleString()} characters · payload v2 · fits \\(\\d+% of budget\\) · expires 2100-01-01T00:00:00\\.000Z · fingerprint ${expectedFingerprint} · written to `,
          "u",
        ),
      );
      assert.equal(result.stderr, "");

      if (process.platform !== "win32") {
        await chmod(output, 0o644);
      }
      const jsonResult = await runCli([
        "build",
        script,
        "--expires",
        "2100-01-01T00:00:00Z",
        "--out",
        output,
        "--json",
      ]);
      assert.equal(jsonResult.stderr, "");
      assert.doesNotMatch(jsonResult.stdout, /https:\/\//u);
      const json = JSON.parse(jsonResult.stdout);
      assert.equal("link" in json, false);
      assert.equal("decoder" in json, false);
      assert.equal(json.out, output);
      assert.equal(json.fingerprint, expectedFingerprint);
      assert.equal(json.fits, true);
      assert.equal(json.characters, link.length);
      assert.equal(json.expiresAt, "2100-01-01T00:00:00.000Z");
      if (process.platform !== "win32") {
        assert.equal((await stat(output)).mode & 0o777, 0o600);
      }
    },
  );
});

test("build rejects invalid or past expiries before producing a link", async () => {
  await withTemporaryScript("js", 'return "https://example.com";\n', async (script) => {
    for (const expires of ["yesterday", "2020-01-01T00:00:00Z"]) {
      await assert.rejects(runCli(["build", script, "--expires", expires, "--json"]), (error) => {
        assert.equal(error.stdout, "");
        assert.doesNotMatch(error.stderr, /https:\/\//u);
        assert.match(error.stderr, /Expected a duration|future date/u);
        return true;
      });
    }
  });
});

test("build reports concise author-note validation errors", async () => {
  await withTemporaryScript("js", 'return { body: "ok" };', async (script) => {
    for (const note of ["   ", "x".repeat(141)]) {
      await assert.rejects(
        runCli(["build", script, "--interstitial-note", note, "--json"]),
        (error) => {
          assert.equal(error.stdout, "");
          assert.doesNotMatch(error.stderr, /\[\s*\{/u);
          assert.match(error.stderr, /interstitial note/u);
          return true;
        },
      );
    }
  });
});

test("decode flags an expired payload", async () => {
  const envelope = { s: "async()=>{}", notAfter: 1 };
  const payload = `2${deflateRawSync(JSON.stringify(envelope), { level: 9 }).toString("base64url")}`;
  const decoded = JSON.parse((await runCli(["decode", payload, "--json"])).stdout);

  assert.equal(decoded.notAfter, 1);
  assert.equal(decoded.expiresAt, "1970-01-01T00:00:01.000Z");
  assert.equal(decoded.expired, true);
});

test("build copies the link without printing it", {
  skip: process.platform === "win32",
}, async () => {
  await withTemporaryScript("js", 'return "https://example.com";\n', async (script) => {
    const directory = dirname(script);
    const clipboardFile = join(directory, "clipboard.txt");
    const clipboardCommand = join(directory, process.platform === "darwin" ? "pbcopy" : "xsel");
    await writeFile(clipboardCommand, '#!/bin/sh\ncat > "$SMARTLINKS_CLIPBOARD_FILE"\n', {
      mode: 0o700,
    });

    const result = await runCli(["build", script, "--copy"], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        SMARTLINKS_CLIPBOARD_FILE: clipboardFile,
      },
    });
    const link = await readFile(clipboardFile, "utf8");
    const expectedFingerprint = fingerprint(link);

    assert.match(link, /^https:\/\/s\.jonaslsa\.com\/r\/2/u);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /https:\/\//u);
    assert.match(
      result.stdout,
      new RegExp(
        `^Copied to clipboard · ${link.length.toLocaleString()} characters · payload v2 · fits \\(\\d+% of budget\\) · fingerprint ${expectedFingerprint}`,
        "u",
      ),
    );

    const jsonResult = await runCli(["build", script, "--copy", "--json"], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        SMARTLINKS_CLIPBOARD_FILE: clipboardFile,
      },
    });
    const json = JSON.parse(jsonResult.stdout);
    assert.equal(json.copied, true);
    assert.equal(json.fingerprint, expectedFingerprint);
    assert.equal("link" in json, false);
    assert.doesNotMatch(jsonResult.stdout, /https:\/\//u);
    assert.equal(jsonResult.stderr, "");
  });
});

test("TypeScript is checked by default and can be explicitly transpiled without checking", async () => {
  const source = 'const value: number = "runtime";\nreturn { body: String(value) };\n';

  await withTemporaryScript("ts", source, async (script) => {
    await assert.rejects(runCli(["build", script, "--json"]), (error) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Could not type-check .*script\.ts/u);
      assert.match(error.stderr, /Type 'string' is not assignable to type 'number'/u);
      return true;
    });

    const built = JSON.parse((await runCli(["build", script, "--no-type-check", "--json"])).stdout);
    assert.match(built.link, /^https:\/\/s\.jonaslsa\.com\/r\/2/u);

    const response = JSON.parse(
      (await runCli(["run", script, "--no-type-check", "--json"])).stdout,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, "runtime");
  });
});

test("run rejects a missing non-interactive secret", async () => {
  const environment = { ...process.env };
  delete environment.SMARTLINKS_E2E_MISSING;

  await withTemporaryScript("js", 'return "https://example.com";\n', async (script) => {
    await assert.rejects(
      runCli(["run", script, "--secret", "SMARTLINKS_E2E_MISSING", "--json"], {
        env: environment,
      }),
      (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /cannot be prompted for/u);
        return true;
      },
    );
  });
});
