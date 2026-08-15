import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

async function runCli(args, options = {}) {
  return exec(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    ...options,
  });
}

async function withTemporaryScript(extension, source, callback) {
  const directory = await mkdtemp(join(tmpdir(), "smartlinks-cli-e2e-"));
  const script = join(directory, `script.${extension}`);
  try {
    await writeFile(script, source);
    return await callback(script);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("the built CLI exposes its version and public subcommands", async () => {
  const version = await runCli(["--version"]);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runCli(["--help"]);
  for (const command of ["build", "decode", "run"]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(help.stdout, /\bkeygen\b/u);

  const buildHelp = await runCli(["help", "build"]);
  assert.doesNotMatch(buildHelp.stdout, /--service\b/u);
  assert.match(buildHelp.stdout, /--no-type-check\b/u);
  assert.match(buildHelp.stdout, /--copy\s+copy the link without printing it/u);
  assert.match(buildHelp.stdout, /--out <file>\s+write the link privately without printing it/u);

  const runHelp = await runCli(["help", "run"]);
  assert.match(runHelp.stdout, /--no-type-check\b/u);
});

test("keygen emits a usable key pair for the requested key ID", async () => {
  const result = await runCli(["keygen", "--key-id", "7", "--json"]);
  const key = JSON.parse(result.stdout);

  assert.equal(key.keyId, 7);
  assert.match(key.publicKey, /^[A-Za-z0-9_-]+$/u);
  assert.match(key.privateKeySecret, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(key.privateKeySecret.split(".")[1], key.publicKey);
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
  headers: { "content-type": "application/json", "x-smartlinks-e2e": "run" },
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
      "--method",
      "post",
      "--body",
      '{"ok":true}',
      "--json",
    ]);
    const response = JSON.parse(result.stdout);

    assert.equal(response.status, 201);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["x-smartlinks-e2e"], "run");
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
      'const name = ctx.params.name ?? "world";\nreturn "https://example.com/" + name;\n',
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
                "--interstitial",
                "--no-minify",
                "--json",
              ],
              { env: { ...process.env, SMARTLINKS_URL: service } },
            )
          ).stdout,
        );

        assert.match(built.link, new RegExp(`^${service}/r/2`));
        assert.equal("decoder" in built, false);
        assert.equal(built.payloadVersion, 2);
        assert.equal(built.characters, built.link.length);
        assert.equal(built.fits, true);
        assert.equal(typeof built.payloadCharacters, "number");
        assert.equal(typeof built.budgetPercent, "number");
        assert.equal(publicKeyRequests, 1);

        const decodedFromUrl = JSON.parse((await runCli(["decode", built.link, "--json"])).stdout);
        assert.equal(decodedFromUrl.payloadVersion, 2);
        assert.equal(decodedFromUrl.interstitial, true);
        assert.deepEqual(decodedFromUrl.sealedSecrets, ["E2E_TOKEN"]);
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
      const result = await runCli(["build", script, "--out", output]);
      const link = (await readFile(output, "utf8")).trim();

      assert.match(link, /^https:\/\/s\.jonaslsa\.com\/r\/2/u);
      assert.doesNotMatch(result.stdout, /https:\/\//u);
      assert.match(
        result.stdout,
        new RegExp(
          `^${link.length.toLocaleString()} characters · payload v2 · fits \\(\\d+% of budget\\) · written to `,
          "u",
        ),
      );
      assert.equal(result.stderr, "");

      if (process.platform !== "win32") {
        await chmod(output, 0o644);
      }
      const jsonResult = await runCli(["build", script, "--out", output, "--json"]);
      assert.equal(jsonResult.stderr, "");
      assert.doesNotMatch(jsonResult.stdout, /https:\/\//u);
      const json = JSON.parse(jsonResult.stdout);
      assert.equal("link" in json, false);
      assert.equal("decoder" in json, false);
      assert.equal(json.out, output);
      assert.equal(json.fits, true);
      assert.equal(json.characters, link.length);
      if (process.platform !== "win32") {
        assert.equal((await stat(output)).mode & 0o777, 0o600);
      }
    },
  );
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

    assert.match(link, /^https:\/\/s\.jonaslsa\.com\/r\/2/u);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /https:\/\//u);
    assert.match(
      result.stdout,
      new RegExp(
        `^Copied to clipboard · ${link.length.toLocaleString()} characters · payload v2 · fits \\(\\d+% of budget\\)`,
        "u",
      ),
    );
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
