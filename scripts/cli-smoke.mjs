import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../dist/index.js", import.meta.url);
const example = new URL("../examples/badge.js", import.meta.url);
const typedExample = new URL("../examples/typed-response.ts", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const version = await exec(process.execPath, [cli.pathname, "--version"]);
if (version.stdout.trim() !== packageJson.version) {
  throw new Error("The CLI version does not match package.json.");
}

const keygen = await exec(process.execPath, [cli.pathname, "keygen", "--json"]);
const key = JSON.parse(keygen.stdout);

const typedRun = await exec(process.execPath, [
  cli.pathname,
  "run",
  typedExample.pathname,
  "--param",
  "name=CLI",
  "--json",
]);
const typedOutput = JSON.parse(typedRun.stdout);
if (typedOutput.status !== 200 || typedOutput.body !== "Hello from TypeScript, CLI!") {
  throw new Error("The TypeScript CLI smoke did not transpile and execute the script.");
}

const defaultBuild = await exec(process.execPath, [
  cli.pathname,
  "build",
  typedExample.pathname,
  "--json",
]);
const defaultOutput = JSON.parse(defaultBuild.stdout);
if (
  typeof defaultOutput.link !== "string" ||
  !defaultOutput.link.startsWith("https://smartlinks-runtime.jonasvox-2014.workers.dev/r/2")
) {
  throw new Error("The CLI did not use the working Smartlinks runtime.");
}

try {
  await exec(process.execPath, [
    cli.pathname,
    "run",
    example.pathname,
    "--secret",
    "SMARTLINKS_SMOKE_MISSING",
    "--json",
  ]);
  throw new Error("The CLI accepted a missing non-interactive secret.");
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("stdout" in error) ||
    error.stdout !== "" ||
    !("stderr" in error) ||
    typeof error.stderr !== "string" ||
    !error.stderr.includes("cannot be prompted for")
  ) {
    throw error;
  }
}

const server = createServer((request, response) => {
  if (request.url === "/pk") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keyId: key.keyId, publicKey: key.publicKey }));
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The CLI smoke server did not expose a TCP port.");
  }
  const built = await exec(
    process.execPath,
    [
      cli.pathname,
      "build",
      typedExample.pathname,
      "--secret",
      "SMARTLINKS_SMOKE_SECRET",
      "--service",
      `http://127.0.0.1:${address.port}`,
      "--json",
    ],
    { env: { ...process.env, SMARTLINKS_SMOKE_SECRET: "sealed" } },
  );
  const output = JSON.parse(built.stdout);
  if (typeof output.link !== "string" || !output.link.includes("/r/2")) {
    throw new Error("The secret-bearing CLI smoke did not produce a v2 smartlink.");
  }
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
