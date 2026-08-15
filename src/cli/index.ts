import { spawn } from "node:child_process";
import { chmod, stat, writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import clipboard from "clipboardy";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import {
  decodePayload,
  formatNotAfter,
  isExpired,
  MAX_PAYLOAD_LENGTH,
  payloadFromInput,
} from "../shared/codec.js";
import { payloadFacts } from "../shared/payload-facts.js";
import { formatStoredScript } from "../shared/script.js";
import { generateKeyPair } from "../shared/seal.js";
import { createSmartlink } from "./build.js";
import { parseExpiry } from "./expiry.js";
import { createSyntheticRequest, executeLocalRequest, LocalScriptError } from "./run.js";
import { serveLocalScript } from "./serve.js";
import type { SimulationReport } from "./simulation.js";
import { readScriptSource } from "./source.js";
import { fail, startUi } from "./ui.js";
import { collect, normalizeServiceUrl, resolveSecrets, splitAssignment } from "./values.js";

declare const __SMARTLINKS_VERSION__: string;

const DEFAULT_SERVICE_URL = "https://s.jonaslsa.com";
const publicKeySchema = z.object({
  keyId: z.number().int().min(1).max(255),
  publicKey: z.string().min(1),
});

type BuildOptions = {
  interstitial?: boolean;
  interstitialNote?: string;
  secret: string[];
  minify: boolean;
  typeCheck: boolean;
  expires?: string;
  copy?: boolean;
  out?: string;
  json?: boolean;
};

type RunOptions = {
  allowNetwork?: boolean;
  simulate?: boolean;
  param: string[];
  secret: string[];
  header: string[];
  method: string;
  body?: string;
  minify: boolean;
  port: number;
  serve?: boolean;
  typeCheck: boolean;
  json?: boolean;
};

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError("The port must be an integer from 0 to 65535.");
  }
  return port;
}

function fitsInteractiveNote(value: string): boolean {
  const availableColumns = Math.max((process.stdout.columns ?? 80) - 6, 20);
  return value.length <= availableColumns;
}

function payloadBudgetPercent(payloadLength: number): number {
  return Math.max(1, Math.round((payloadLength / MAX_PAYLOAD_LENGTH) * 100));
}

function buildStats(linkLength: number, payloadLength: number, notAfter?: number): string {
  const budgetPercent = payloadBudgetPercent(payloadLength);
  return [
    `${linkLength.toLocaleString()} characters`,
    "payload v2",
    `fits (${budgetPercent}% of budget)`,
    notAfter === undefined ? undefined : `expires ${formatNotAfter(notAfter)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
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

function formatSimulationReport(report: SimulationReport): string {
  const lines = [
    `Input · ${report.inputs.method}`,
    ...(Object.keys(report.inputs.params).length
      ? [`Parameters · ${JSON.stringify(report.inputs.params)}`]
      : []),
    ...(Object.keys(report.inputs.headers).length
      ? [`Headers · ${JSON.stringify(report.inputs.headers)}`]
      : []),
    ...(report.inputs.body === null ? [] : [`Body · ${report.inputs.body}`]),
  ];

  for (const [index, event] of report.events.entries()) {
    if (event.type === "fetch") {
      lines.push(`Fetch ${index + 1} · ${event.request.method} ${event.request.url}`);
      if (Object.keys(event.request.headers).length) {
        lines.push(`  Headers · ${JSON.stringify(event.request.headers)}`);
      }
      if (event.request.body !== null) {
        lines.push(`  Body · ${event.request.body}`);
      }
      lines.push(`  Synthetic response · HTTP ${event.response.status} · ${event.response.body}`);
    } else if (event.type === "fetch-blocked") {
      lines.push(
        `Fetch ${index + 1} blocked · ${event.request.method} ${event.request.url}`,
        `  ${event.reason}`,
      );
    } else {
      const secrets = event.artifact.sealedSecrets.join(", ") || "none";
      lines.push(
        `Compiled child ${event.hop} · payload v${event.artifact.payloadVersion} · ${event.artifact.payloadCharacters.toLocaleString()} characters · sealed secrets: ${secrets}`,
      );
    }
  }

  if (report.response) {
    lines.push(`Final response · HTTP ${report.response.status}`);
    if (Object.keys(report.response.headers).length) {
      lines.push(`  Headers · ${JSON.stringify(report.response.headers)}`);
    }
    lines.push(
      "body" in report.response
        ? `  Body · ${report.response.body || "(empty)"}`
        : `  Body · ${Buffer.from(report.response.bodyBase64, "base64").byteLength.toLocaleString()} binary bytes`,
    );
  }
  if (report.error) {
    lines.push(`Execution error · ${report.error}`);
  }
  return lines.join("\n");
}

function printSimulationReport(
  report: SimulationReport,
  options: Pick<RunOptions, "json">,
  interactive: boolean,
): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const formatted = formatSimulationReport(report);
  if (interactive) {
    p.note(formatted, "Network simulation");
    p.outro("One deterministic path · no network requests were sent");
  } else {
    console.log(formatted);
    console.error("One deterministic path · no network requests were sent");
  }
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
  const notAfter = options.expires === undefined ? undefined : parseExpiry(options.expires);
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
    ...(options.interstitialNote === undefined
      ? {}
      : { interstitialNote: options.interstitialNote }),
    ...(notAfter !== undefined ? { notAfter } : {}),
    minify: options.minify,
  });
  if (isExpired(notAfter)) {
    throw new Error("The link expired before the build completed. Choose a later expiry.");
  }

  if (options.copy) {
    await clipboard.write(created.link);
  }
  if (options.out) {
    await writeFile(options.out, `${created.link}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(options.out, 0o600);
    }
  }

  const stats = buildStats(created.link.length, created.payload.length, notAfter);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...(!options.copy && !options.out ? { link: created.link } : {}),
          characters: created.link.length,
          payloadCharacters: created.payload.length,
          payloadVersion: 2,
          ...(created.interstitialNote === undefined
            ? {}
            : { interstitialNote: created.interstitialNote }),
          ...(notAfter === undefined
            ? {}
            : { notAfter, expiresAt: formatNotAfter(notAfter), expired: false }),
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
  const closures = (decoded.envelope.c ?? []).map((closure) => formatStoredScript("2", closure));
  const metadata = payloadFacts(decoded);
  const interstitialNote = decoded.envelope.interstitialNote ?? null;

  if (options.json) {
    console.log(JSON.stringify({ ...metadata, interstitialNote, script, closures }, null, 2));
    return;
  }
  const interactive = startUi("smartlinks decode", false);
  if (interactive) {
    if (interstitialNote !== null) {
      p.note(interstitialNote, "Author-provided note");
    }
    p.note(script, "Script");
    closures.forEach((closure, index) => {
      p.note(closure, `Compile closure ${index}`);
    });
    p.note(
      `Version: ${metadata.payloadVersion}\nConfirmation: ${metadata.interstitial ? "yes" : "no"}\nCompile closures: ${metadata.compileClosures}\nSealed secrets: ${metadata.sealedSecrets.join(", ") || "none"}\nExpiry: ${metadata.expiresAt === null ? "never" : `${metadata.expiresAt}${metadata.expired ? " (expired)" : ""}`}`,
      "Metadata",
    );
    p.outro("Decoded without executing");
  } else {
    console.log(
      [script, ...closures.map((closure, index) => `// Compile closure ${index}\n${closure}`)].join(
        "\n\n",
      ),
    );
    console.error(JSON.stringify({ ...metadata, interstitialNote }));
  }
}

async function runCommand(file: string, options: RunOptions): Promise<void> {
  const interactive = startUi("smartlinks run", options.json === true);
  const parameters = options.param.map((value) => splitAssignment(value, "Parameter"));
  const requestHeaders = options.header.map((value) => splitAssignment(value, "Header"));
  const executionOptions = {
    allowNetwork: options.allowNetwork === true,
    blockedHostnames:
      options.allowNetwork === true || options.simulate === true
        ? [new URL(normalizeServiceUrl(process.env.SMARTLINKS_URL ?? DEFAULT_SERVICE_URL)).hostname]
        : [],
    file,
    minify: options.minify,
    secrets: await resolveSecrets(options.secret, { prompt: interactive }),
    simulate: options.simulate === true,
    typeCheck: options.typeCheck,
  };

  if (options.serve) {
    await serveLocalScript({
      ...executionOptions,
      port: options.port,
      onListen: (url) => {
        if (interactive) {
          p.log.success(`Serving ${file} at ${url}`);
          p.log.info("Save the script and refresh the browser · Ctrl+C to stop");
        } else {
          console.log(`Serving ${file} at ${url}`);
        }
      },
    });
    if (interactive) {
      p.outro("Local server stopped");
    }
    return;
  }

  const request = createSyntheticRequest({
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: requestHeaders,
    method: options.method,
    parameters,
  });
  let execution: Awaited<ReturnType<typeof executeLocalRequest>>;
  try {
    execution = await executeLocalRequest(request, executionOptions);
  } catch (error) {
    if (options.simulate && error instanceof LocalScriptError && error.simulation) {
      printSimulationReport(error.simulation, options, interactive);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const { binary, response } = execution;
  if (execution.simulation) {
    printSimulationReport(execution.simulation, options, interactive);
    return;
  }
  const binaryBody = binary ? Buffer.from(await response.arrayBuffer()) : undefined;
  const responseHeaders = Object.fromEntries(response.headers);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          status: response.status,
          headers: responseHeaders,
          ...(binaryBody === undefined
            ? { body: await response.text() }
            : { bodyBase64: binaryBody.toString("base64") }),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (interactive) {
    if (binaryBody === undefined) {
      p.note((await response.text()) || "(empty)", `Response · HTTP ${response.status}`);
    } else {
      p.note(
        `${binaryBody.byteLength.toLocaleString()} bytes · use --json for Base64 or redirect stdout for raw bytes`,
        `Binary response · HTTP ${response.status}`,
      );
    }
    if (Object.keys(responseHeaders).length) {
      p.log.info(JSON.stringify(responseHeaders));
    }
    p.outro("Executed locally in a fresh QuickJS sandbox");
  } else if (binaryBody !== undefined) {
    process.stdout.write(binaryBody);
    console.error(`HTTP ${response.status}`);
  } else {
    console.log(await response.text());
    console.error(`HTTP ${response.status}`);
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
  .option("--interstitial-note <text>", "add an author note and require browser confirmation")
  .option("-s, --secret <NAME[=value]>", "seal a secret; repeatable", collect, [])
  .option("--expires <duration-or-date>", "expire after a duration or at an ISO 8601 date")
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
  .addOption(
    new Option("-p, --param <NAME=value>", "query parameter; repeatable")
      .argParser(collect)
      .default([])
      .conflicts("serve"),
  )
  .option("-s, --secret <NAME[=value]>", "secret from value, environment, or prompt", collect, [])
  .addOption(
    new Option("-H, --header <NAME=value>", "request header; repeatable")
      .argParser(collect)
      .default([])
      .conflicts("serve"),
  )
  .addOption(
    new Option("-X, --method <method>", "request method").default("GET").conflicts("serve"),
  )
  .addOption(new Option("--body <text>", "request body").conflicts("serve"))
  .addOption(
    new Option("--allow-network", "allow guarded outbound fetch calls").conflicts("simulate"),
  )
  .addOption(
    new Option("--simulate", "trace fetch calls without sending network requests").conflicts([
      "allowNetwork",
      "serve",
    ]),
  )
  .option("--serve", "serve the script on a loopback HTTP server")
  .addOption(
    new Option("--port <number>", "serve port; use 0 to choose an available port")
      .argParser(parsePort)
      .default(8787)
      .implies({ serve: true }),
  )
  .addOption(new Option("--json", "print machine-readable output").conflicts("serve"))
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
