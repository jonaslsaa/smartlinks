import { z } from "zod";
import { type DecodedPayload, type Envelope, MAX_NOT_AFTER, type PayloadVersion } from "./codec.js";
import type { CryptoOperationBudget } from "./guest-crypto.js";
import { artifactSecretBinding, type PublicKey, sealSecret } from "./seal.js";

export const MAX_COMPILE_ARGUMENT_BYTES = 64_000;
export const MAX_COMPILE_ARGUMENT_DEPTH = 32;
export const MAX_COMPILE_ARGUMENT_VALUES = 10_000;
const MAX_SEALED_VALUE_LENGTH = 1_024;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

type JsonValue = string | number | boolean | null | JsonValue[] | { [name: string]: JsonValue };

const compileOptionsSchema = z
  .object({
    seal: z
      .record(
        z.string().regex(SECRET_NAME, "Secret names must look like environment variables."),
        z.string().max(MAX_SEALED_VALUE_LENGTH),
      )
      .optional(),
    ttlSeconds: z.number().int().positive().max(MAX_NOT_AFTER).optional(),
    interstitial: z.boolean().optional(),
  })
  .strict();

function parseCompileOptions(raw: unknown): z.infer<typeof compileOptionsSchema> {
  const parsed = compileOptionsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  throw new Error(
    `Invalid ctx.compile ${field ? `option ${field}` : "options"}: ${issue?.message ?? "invalid value"}.`,
  );
}

export type MintEncoder = (envelope: Envelope, version: PayloadVersion) => Promise<string>;

export type SmartlinkCompilerOptions = {
  parent: DecodedPayload;
  parentSecrets: Readonly<Record<string, string>>;
  service: string;
  getPublicKey: () => PublicKey | Promise<PublicKey>;
  encode: MintEncoder;
  validate: (version: PayloadVersion, source: string) => Promise<void>;
  cryptoBudget: CryptoOperationBudget;
  nowSeconds?: () => number;
};

export type GuestCompile = (
  closureIndex: unknown,
  args: unknown,
  rawOptions: unknown,
) => Promise<string>;

type JsonState = { values: number };

function normalizeJson(value: unknown, depth: number, state: JsonState): JsonValue {
  state.values += 1;
  if (state.values > MAX_COMPILE_ARGUMENT_VALUES) {
    throw new Error(`Compile arguments may contain at most ${MAX_COMPILE_ARGUMENT_VALUES} values.`);
  }
  if (depth > MAX_COMPILE_ARGUMENT_DEPTH) {
    throw new Error(
      `Compile arguments may be nested at most ${MAX_COMPILE_ARGUMENT_DEPTH} levels.`,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Compile arguments may contain only finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry, depth + 1, state));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const normalized: { [name: string]: JsonValue } = {};
    for (const [name, entry] of entries) {
      if (name === "__proto__") {
        throw new Error('Compile arguments may not contain a "__proto__" key.');
      }
      normalized[name] = normalizeJson(entry, depth + 1, state);
    }
    return normalized;
  }
  throw new Error("Compile arguments must be JSON-serializable values.");
}

function serializedArguments(raw: unknown): { args: JsonValue[]; json: string } {
  if (!Array.isArray(raw)) {
    throw new Error("ctx.compile requires an argument tuple as its second argument.");
  }
  const args = normalizeJson(raw, 0, { values: 0 });
  if (!Array.isArray(args)) {
    throw new Error("ctx.compile requires an argument tuple as its second argument.");
  }
  const json = JSON.stringify(args);
  if (new TextEncoder().encode(json).byteLength > MAX_COMPILE_ARGUMENT_BYTES) {
    throw new Error("Compile arguments exceed the 64 KB limit.");
  }
  return { args, json };
}

function stringLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function compiledChildSource(closure: string, argumentJson: string): string {
  return `async ctx=>(${closure})(ctx,...JSON.parse(${stringLiteral(argumentJson)}))`;
}

function childNotAfter(
  parentNotAfter: number | undefined,
  ttlSeconds: number | undefined,
  nowSeconds: number,
): number | undefined {
  if (parentNotAfter !== undefined && parentNotAfter <= nowSeconds) {
    throw new Error("An expired smartlink cannot compile a child.");
  }
  if (ttlSeconds === undefined) {
    return parentNotAfter;
  }
  const requested = nowSeconds + ttlSeconds;
  if (!Number.isSafeInteger(requested) || requested > MAX_NOT_AFTER) {
    throw new Error("The child expiry is outside the supported range.");
  }
  return parentNotAfter === undefined ? requested : Math.min(requested, parentNotAfter);
}

function assertNoPlaintextSecrets(
  source: string,
  closures: readonly string[],
  args: readonly JsonValue[],
  argumentJson: string,
  secrets: Readonly<Record<string, string>>,
): void {
  const containsSecret = (value: JsonValue, secret: string): boolean => {
    if (typeof value === "string") {
      return value.includes(secret);
    }
    if (Array.isArray(value)) {
      return value.some((entry) => containsSecret(entry, secret));
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).some(
        ([name, entry]) => name.includes(secret) || containsSecret(entry, secret),
      );
    }
    return false;
  };

  for (const [name, value] of Object.entries(secrets)) {
    if (
      value &&
      (source.includes(value) ||
        argumentJson.includes(value) ||
        args.some((argument) => containsSecret(argument, value)) ||
        closures.some((closure) => closure.includes(value)))
    ) {
      throw new Error(
        `Compile output contains plaintext from ctx.secrets.${name}. Pass it through options.seal instead.`,
      );
    }
  }
}

export function createSmartlinkCompiler(options: SmartlinkCompilerOptions): GuestCompile {
  const closures = options.parent.envelope.c ?? [];
  const service = options.service.replace(/\/$/u, "");

  return async (rawClosureIndex, rawArgs, rawOptions) => {
    const closureIndex = z.number().int().nonnegative().parse(rawClosureIndex);
    const closure = closures[closureIndex];
    if (!closure) {
      throw new Error(`Compile closure ${closureIndex} is unavailable.`);
    }
    const { args, json: argumentJson } = serializedArguments(rawArgs);
    const compileOptions = parseCompileOptions(rawOptions);
    const nowSeconds = options.nowSeconds?.() ?? Math.floor(Date.now() / 1_000);
    const notAfter = childNotAfter(
      options.parent.envelope.notAfter,
      compileOptions.ttlSeconds,
      nowSeconds,
    );
    const interstitial = compileOptions.interstitial ?? options.parent.envelope.i === true;
    const source = compiledChildSource(closure, argumentJson);
    assertNoPlaintextSecrets(source, closures, args, argumentJson, options.parentSecrets);
    await options.validate(options.parent.version, source);

    const secretEntries = Object.entries(compileOptions.seal ?? {});
    options.cryptoBudget.consume(secretEntries.length);
    const envelope = {
      s: source,
      ...(interstitial ? { i: true as const } : {}),
      ...(closures.length ? { c: closures } : {}),
      ...(secretEntries.length ? { a: 1 as const } : {}),
      ...(notAfter === undefined ? {} : { notAfter }),
    };
    const publicKey = secretEntries.length ? await options.getPublicKey() : undefined;
    const sealedEntries = publicKey
      ? await Promise.all(
          secretEntries.map(
            async ([name, value]) =>
              [
                name,
                await sealSecret(
                  value,
                  artifactSecretBinding(options.parent.version, envelope, name),
                  publicKey,
                ),
              ] as const,
          ),
        )
      : [];
    const payload = await options.encode(
      {
        ...envelope,
        ...(sealedEntries.length ? { k: Object.fromEntries(sealedEntries) } : {}),
      },
      options.parent.version,
    );
    return `${service}/r/${payload}`;
  };
}
