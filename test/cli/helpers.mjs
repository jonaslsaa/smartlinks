import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

export async function runCli(args, options = {}) {
  return exec(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    ...options,
  });
}

export async function withTemporaryScript(extension, source, callback) {
  const directory = await mkdtemp(join(tmpdir(), "smartlinks-cli-e2e-"));
  const script = join(directory, `script.${extension}`);
  try {
    await writeFile(script, source);
    return await callback(script);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
