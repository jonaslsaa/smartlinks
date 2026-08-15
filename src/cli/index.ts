import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { chmod, stat, writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import clipboard from "clipboardy";
import { Command, Option } from "commander";
import { z } from "zod";
import { decodePayload, MAX_PAYLOAD_LENGTH, payloadFromInput } from "../shared/codec.js";
import { createGuardedFetch } from "../shared/guarded-fetch.js";
import {
  createRequestId,
  localRequestBody,
  lowercaseHeaders,
  userParams,
  userParamValues,
} from "../shared/request-context.js";
import { mapScriptResult } from "../shared/result.js";
import { runScript } from "../shared/sandbox.js";
import { formatStoredScript, minifyScriptBody, wrapScriptBody } from "../shared/script.js";
import { generateKeyPair } from "../shared/seal.js";
import { createSmartlink } from "./build.js";
import { createNodeFetch } from "./node-fetch.js";
import { readScriptSource } from "./source.js";
import { fail, startUi } from "./ui.js";
import { collect, normalizeServiceUrl, resolveSecrets, splitAssignment } from "./values.js";

declare const __SMARTLINKS_VERSION__: string;

// Node 18 exposes Web Crypto from node:crypto, but not as a global by default.
// HPKE and the shared Worker code use the standard global Web Crypto interface.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

const DEFAULT_SERVICE_URL = "https://s.jonaslsa.com";
const publicKeySchema = z.object({
  keyId: z.number().int().min(1).max(255),
  publicKey: z.string().min(1),
});

type BuildOptions = {
  interstitial?: boolean;
  secret: string[];
  minify: boolean;
  typeCheck: boolean;
  copy?: boolean;
  out?: string;
  json?: boolean;
};

type RunOptions = {
  allowNetwork?: boolean;
  param: string[];
  secret: string[];
  header: string[];
  method: string;
  body?: string;
  minify: boolean;
  typeCheck: boolean;
  json?: boolean;
};

function fitsInteractiveNote(value: string): boolean {
  const availableColumns = Math.max((process.stdout.columns ?? 80) - 6, 20);
  return value.length <= availableColumns;
}

function payloadBudgetPercent(payloadLength: number): number {
  return Math.max(1, Math.round((payloadLength / MAX_PAYLOAD_LENGTH) * 100));
}

function buildStats(linkLength: number, payloadLength: number): string {
  const budgetPercent = payloadBudgetPercent(payloadLength);
  return `${linkLength.toLocaleString()} characters · payload v2 · fits (${budgetPercent}% of budget)`;
}

function buildReceipt(stats: string, options: Pick<BuildOptions, "copy" | "out">): string {
  return [
    options.copy ? "Copied to clipboard" : undefined,
    stats,
    options.out ? `written to ${options.out}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

async function assertOutputDoesNotOverwriteInput(input: string, output: string): Promise<void> {
  const [inputStats, outputStats] = await Promise.all([
    stat(input),
    stat(output).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }),
  ]);
  if (outputStats && inputStats.dev === outputStats.dev && inputStats.ino === outputStats.ino) {
    throw new Error("The build output must not overwrite the input script.");
  }
}

async function fetchPublicKey(service: string): Promise<z.infer<typeof publicKeySchema>> {
  let response: Response;
  try {
    response = await fetch(`${service}/pk`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Could not reach ${service}/pk. Set SMARTLINKS_URL to your deployed runtime.`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`The service returned HTTP ${response.status} from /pk.`);
  }
  return publicKeySchema.parse(await response.json());
}

async function buildCommand(file: string, options: BuildOptions): Promise<void> {
  const interactive = startUi("smartlinks build", options.json === true);
  if (options.out) {
    await assertOutputDoesNotOverwriteInput(file, options.out);
  }
  const originalSource = await readScriptSource(file, { typeCheck: options.typeCheck });
  const secrets = await resolveSecrets(options.secret, { prompt: interactive });
  const service = normalizeServiceUrl(process.env.SMARTLINKS_URL ?? DEFAULT_SERVICE_URL);

  let publicKey: z.infer<typeof publicKeySchema> | undefined;
  if (Object.keys(secrets).length > 0) {
    const spinner = interactive ? p.spinner() : undefined;
    spinner?.start("Fetching public key and sealing secrets");
    publicKey = await fetchPublicKey(service);
    spinner?.stop(`Fetched encryption key ${publicKey.keyId}`);
  }

  const created = await createSmartlink({
    source: originalSource,
    service,
    secrets,
    ...(publicKey ? { publicKey } : {}),
    ...(options.interstitial ? { interstitial: true } : {}),
    minify: options.minify,
  });

  if (options.copy) {
    await clipboard.write(created.link);
  }
  if (options.out) {
    await writeFile(options.out, `${created.link}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(options.out, 0o600);
    }
  }

  const stats = buildStats(created.link.length, created.payload.length);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...(!options.copy && !options.out ? { link: created.link } : {}),
          characters: created.link.length,
          payloadCharacters: created.payload.length,
          payloadVersion: 2,
          budgetPercent: payloadBudgetPercent(created.payload.length),
          fits: true,
          ...(options.copy ? { copied: true } : {}),
          ...(options.out ? { out: options.out } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (interactive) {
    if (options.copy || options.out) {
      p.outro(buildReceipt(stats, options));
    } else {
      if (fitsInteractiveNote(created.link)) {
        p.note(created.link, "Smartlink");
      } else {
        p.log.success("Smartlink ready");
        p.log.message(created.link);
      }
      p.log.info("Audit: run smartlinks decode with the link above");
      p.outro(stats);
    }
  } else if (options.copy || options.out) {
    console.log(buildReceipt(stats, options));
  } else {
    console.log(created.link);
    console.error("Audit: run smartlinks decode with the link above");
    console.error(stats);
  }
}

async function decodeCommand(input: string, options: { json?: boolean }): Promise<void> {
  const decoded = decodePayload(payloadFromInput(input));
  const script = formatStoredScript(decoded.version, decoded.envelope.s);
  const metadata = {
    payloadVersion: Number(decoded.version),
    interstitial: decoded.envelope.i === true,
    sealedSecrets: Object.keys(decoded.envelope.k ?? {}),
  };

  if (options.json) {
    console.log(JSON.stringify({ ...metadata, script }, null, 2));
    return;
  }
  const interactive = startUi("smartlinks decode", false);
  if (interactive) {
    p.note(script, "Script");
    p.note(
      `Version: ${metadata.payloadVersion}\nConfirmation: ${metadata.interstitial ? "yes" : "no"}\nSealed secrets: ${metadata.sealedSecrets.join(", ") || "none"}`,
      "Metadata",
    );
    p.outro("Decoded without executing");
  } else {
    console.log(script);
    console.error(JSON.stringify(metadata));
  }
}

async function runCommand(file: string, options: RunOptions): Promise<void> {
  const interactive = startUi("smartlinks run", options.json === true);
  const originalSource = await readScriptSource(file, { typeCheck: options.typeCheck });
  const source = options.minify
    ? await minifyScriptBody(originalSource)
    : wrapScriptBody(originalSource);
  const method = options.method.toUpperCase();
  const parameters = options.param.map((value) => splitAssignment(value, "Parameter"));
  const guestFetch = options.allowNetwork
    ? createGuardedFetch({ fetchImpl: createNodeFetch() })
    : async () => {
        throw new Error("Network access is disabled. Re-run with --allow-network to enable fetch.");
      };
  const result = await runScript({
    version: "2",
    source,
    context: {
      params: userParams(parameters),
      paramValues: userParamValues(parameters),
      method,
      headers: lowercaseHeaders(
        options.header.map((value) => splitAssignment(value, "Header")),
        true,
      ),
      body: localRequestBody(method, options.body),
      secrets: await resolveSecrets(options.secret, { prompt: interactive }),
      requestId: createRequestId(),
    },
    fetch: guestFetch,
  });
  const response = mapScriptResult(result);
  const output = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (interactive) {
    p.note(output.body || "(empty)", `Response · HTTP ${output.status}`);
    if (Object.keys(output.headers).length) {
      p.log.info(JSON.stringify(output.headers));
    }
    p.outro("Executed locally in a fresh QuickJS sandbox");
  } else {
    console.log(output.body);
    console.error(`HTTP ${output.status}`);
  }
}

async function storeWorkerSecret(name: string, value: string, json: boolean): Promise<void> {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const subprocess = spawn(executable, ["wrangler", "secret", "put", name], {
    stdio: ["pipe", json ? "pipe" : "inherit", "inherit"],
  });
  subprocess.stdout?.pipe(process.stderr);
  if (!subprocess.stdin) {
    throw new Error("Could not open Wrangler's standard input.");
  }
  subprocess.stdin.end(value);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`Wrangler exited with code ${exitCode ?? "unknown"}.`);
  }
}

async function keygenCommand(options: {
  keyId: string;
  json?: boolean;
  setWorker?: boolean;
}): Promise<void> {
  const generated = await generateKeyPair(Number(options.keyId));
  const name = `PRIVATE_KEY_${generated.keyId}`;
  if (options.setWorker) {
    await storeWorkerSecret(name, generated.privateKeySecret, options.json === true);
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        options.setWorker
          ? { keyId: generated.keyId, publicKey: generated.publicKey, workerSecret: name }
          : generated,
        null,
        2,
      ),
    );
    return;
  }

  const interactive = startUi("smartlinks keygen", false);
  if (interactive) {
    if (options.setWorker) {
      p.log.success(`Stored ${name} with Wrangler`);
    } else {
      p.note(generated.privateKeySecret, `${name} value · shown once`);
      p.log.info(`Store it securely with: npx wrangler secret put ${name}`);
    }
    p.log.info(`Public key: ${generated.publicKey}`);
    p.outro("Keep older private-key secrets deployed so existing links continue to work");
  } else if (options.setWorker) {
    console.log(`Stored ${name}.`);
    console.error(`Public key: ${generated.publicKey}`);
  } else {
    console.log(generated.privateKeySecret);
    console.error(`Secret name: ${name}`);
    console.error(`Public key: ${generated.publicKey}`);
  }
}

const program = new Command()
  .name("smartlinks")
  .description("Turn small JavaScript programs into self-contained, executable URLs.")
  .version(__SMARTLINKS_VERSION__)
  .showHelpAfterError()
  .addHelpText(
    "after",
    `\nExamples:\n  smartlinks build script.js --interstitial\n  smartlinks build script.js --secret GITHUB_TOKEN --copy\n  smartlinks decode 'https://service.example/r/2…'\n  smartlinks run script.js --param owner=jonaslsaa\n`,
  );

program
  .command("build")
  .description("Minify a script and build an executable smartlink.")
  .argument("<script.js|script.ts>", "JavaScript or TypeScript function body to encode")
  .option("-i, --interstitial", "require browser confirmation before execution")
  .option("-s, --secret <NAME[=value]>", "seal a secret; repeatable", collect, [])
  .option("--copy", "copy the link without printing it")
  .option("--out <file>", "write the link privately without printing it")
  .option("--json", "print machine-readable output")
  .addOption(new Option("--no-type-check", "skip strict type checking for TypeScript input"))
  .addOption(new Option("--no-minify", "skip JavaScript minification"))
  .action(buildCommand);

program
  .command("decode")
  .description("Inspect a smartlink without executing it.")
  .argument("<link-or-payload>", "smartlink URL or encoded payload")
  .option("--json", "print machine-readable output")
  .action(decodeCommand);

program
  .command("run")
  .description("Execute a script locally in the production QuickJS sandbox.")
  .argument("<script.js|script.ts>", "JavaScript or TypeScript function body to execute")
  .option("-p, --param <NAME=value>", "query parameter; repeatable", collect, [])
  .option("-s, --secret <NAME[=value]>", "secret from value, environment, or prompt", collect, [])
  .option("-H, --header <NAME=value>", "request header; repeatable", collect, [])
  .option("-X, --method <method>", "request method", "GET")
  .option("--body <text>", "request body")
  .option("--allow-network", "allow guarded outbound fetch calls")
  .option("--json", "print machine-readable output")
  .addOption(new Option("--no-type-check", "skip strict type checking for TypeScript input"))
  .addOption(new Option("--no-minify", "skip JavaScript minification"))
  .action(runCommand);

program
  .command("keygen", { hidden: true })
  .description("Generate an X25519 HPKE key pair for the Worker.")
  .option("--key-id <number>", "one-byte rotation key ID", "1")
  .option("--set-worker", "store the private key using Wrangler instead of printing it")
  .option("--json", "print machine-readable output")
  .action(keygenCommand);

program.parseAsync().catch((error: unknown) => {
  fail(error);
  process.exitCode = 1;
});
