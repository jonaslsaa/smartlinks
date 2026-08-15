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
    `const response = await fetch(${JSON.stringify(landingUrl.href)});
const html = await response.text();
if (!response.ok || !html.includes("<title>Smartlinks</title>")) {
  return { status: 502, body: "Landing fetch failed" };
}
return { headers: { "x-smartlinks-smoke": "global-fetch" }, body: "global-fetch-ok" };
`,
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(projectRoot, "dist/index.js"), "build", script, "--json"],
    {
      cwd: projectRoot,
      env: { ...process.env, SMARTLINKS_URL: runtimeUrl.origin },
    },
  );
  const built = JSON.parse(stdout);

  await retry("global fetch smoke", async () => {
    const response = await fetch(built.link, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    assert(response.status === 200, `Expected Smartlink status 200, received ${response.status}.`);
    assert(
      response.headers.get("x-smartlinks-smoke") === "global-fetch",
      "Expected the global fetch smoke response header.",
    );
    assert(body === "global-fetch-ok", `Unexpected global fetch smoke body: ${body}`);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(`Production Worker smoke passed at ${runtimeUrl.origin}.`);
