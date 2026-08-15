#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeUrl = new URL(process.env.SMARTLINKS_URL ?? "https://s.jonaslsa.com");
const landingUrl = new URL(
  process.env.LANDING_URL ?? "https://smartlinks.jonaslsa.com/",
);
const attempts = 10;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function retry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts.`, { cause: lastError });
}

function fetchRuntime(path) {
  return fetch(new URL(path, runtimeUrl), {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

await retry("Worker root smoke", async () => {
  const response = await fetchRuntime("/");
  assert(response.status === 302, `Expected Worker root status 302, received ${response.status}.`);
  assert(
    response.headers.get("location") === landingUrl.href,
    `Expected Worker root to redirect to ${landingUrl.href}.`,
  );
});

await retry("public-key smoke", async () => {
  const response = await fetchRuntime("/pk");
  assert(response.ok, `Expected /pk status 200, received ${response.status}.`);
  const body = await response.json();
  assert(body.keyId === 1, "Expected /pk to return key ID 1.");
  assert(
    body.suite === "HPKE-X25519-HKDF-SHA256-AES128GCM",
    "Expected /pk to return the active HPKE suite.",
  );
  assert(typeof body.publicKey === "string" && body.publicKey.length > 20, "Invalid public key.");
});

const directory = await mkdtemp(join(tmpdir(), "smartlinks-worker-smoke-"));
const script = join(directory, "global-fetch.js");
try {
  await writeFile(
    script,
    `const child = async (childCtx, landing) => {
  const response = await fetch(landing);
  const html = await response.text();
  if (!response.ok || !html.includes("<title>Smartlinks</title>")) {
    return { status: 502, body: "Landing fetch failed" };
  }
  return {
    headers: { "x-smartlinks-smoke": "compiled-child" },
    body: \`compile-ok:\${childCtx.secrets.CHILD_SECRET}\`,
  };
};
return ctx.compile(child, [${JSON.stringify(landingUrl.href)}], {
  ttlSeconds: 120,
  seal: { CHILD_SECRET: ctx.secrets.SMARTLINKS_SMOKE_SECRET },
});
`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(projectRoot, "dist/index.js"),
      "build",
      script,
      "--secret",
      "SMARTLINKS_SMOKE_SECRET",
      "--expires",
      "10m",
      "--json",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        SMARTLINKS_SMOKE_SECRET: "sealed-smoke-ok",
        SMARTLINKS_URL: runtimeUrl.origin,
      },
    },
  );
  const built = JSON.parse(stdout);
  assert(built.payloadVersion === 2, "Expected a payload v2 smoke link.");
  assert(built.expired === false, "Expected a future smoke-link expiry.");
  assert(
    typeof built.notAfter === "number" && built.notAfter > Math.floor(Date.now() / 1_000),
    "Expected the smoke link to include a future notAfter value.",
  );

  const childLink = await retry("runtime compile smoke", async () => {
    const response = await fetch(built.link, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.status === 302, `Expected parent status 302, received ${response.status}.`);
    const location = response.headers.get("location");
    assert(location?.startsWith(`${runtimeUrl.origin}/r/2`), "Expected a compiled child URL.");
    return location;
  });

  await retry("sealed compiled child and global fetch smoke", async () => {
    const response = await fetch(childLink, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert(response.status === 200, `Expected Smartlink status 200, received ${response.status}.`);
    assert(
      response.headers.get("x-smartlinks-smoke") === "compiled-child",
      "Expected the compiled-child smoke response header.",
    );
    assert(
      body === "compile-ok:sealed-smoke-ok",
      `Unexpected compiled child smoke body: ${body}`,
    );
  });
  const tokenScript = join(directory, "token.js");
  await writeFile(
    tokenScript,
    `if (ctx.params.t) {
  const state = await ctx.crypto.open(ctx.params.t, { context: "smoke" });
  return { body: \`token-ok:\${state.n}\` };
}
return { body: await ctx.crypto.seal({ n: 7 }, { context: "smoke" }) };
`,
  );
  const tokenBuild = await execFileAsync(
    process.execPath,
    [join(projectRoot, "dist/index.js"), "build", tokenScript, "--expires", "10m", "--json"],
    {
      cwd: projectRoot,
      env: { ...process.env, SMARTLINKS_URL: runtimeUrl.origin },
    },
  );
  const tokenLink = JSON.parse(tokenBuild.stdout).link;

  const token = await retry("token seal smoke", async () => {
    const response = await fetch(tokenLink, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.status === 200, `Expected token seal status 200, received ${response.status}.`);
    const body = await response.text();
    assert(/^[A-Za-z0-9_-]{30,}$/u.test(body), `Expected a base64url token, received: ${body}`);
    return body;
  });

  await retry("token open smoke", async () => {
    const response = await fetch(`${tokenLink}?t=${token}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert(response.status === 200, `Expected token open status 200, received ${response.status}.`);
    assert(body === "token-ok:7", `Unexpected token open smoke body: ${body}`);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(`Production Worker smoke passed at ${runtimeUrl.origin}.`);
