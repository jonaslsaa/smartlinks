import { toBase64Url, utf8 } from "../shared/bytes.js";
import {
  type DecodedPayload,
  decodePayload,
  isExpired,
  payloadFromInput,
} from "../shared/codec.js";
import { createGuardedFetch, type GuestFetch } from "../shared/guarded-fetch.js";
import {
  createCryptoOperationBudget,
  createGuestCrypto,
  type GuestRandomBytes,
  MIN_TOKEN_KEY_BYTES,
} from "../shared/guest-crypto.js";
import { createSmartlinkCompiler } from "../shared/mint.js";
import { createRequestId, userParams, userParamValues } from "../shared/request-context.js";
import type { ScriptResult } from "../shared/result.js";
import { runScript, type SandboxContext, validateScript } from "../shared/sandbox.js";
import {
  boundSealedSecrets,
  type GeneratedKeyPair,
  generateKeyPair,
  openSecret,
  payloadArtifactIdentity,
  sealedSecretKeyId,
} from "../shared/seal.js";
import { encodePayloadForCli } from "./encode.js";
import { createNodeFetch } from "./node-fetch.js";
import type { LocalSimulation } from "./simulation.js";

const LOCAL_SERVICE_URL = "https://smartlinks.local";
const MAX_COMPILE_REDIRECTS = 10;
// Process-wide so tokens survive across the requests of one `run --serve` session.
const ephemeralMasterSecret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const LOCAL_TOKEN_KEY_ENV = "SMARTLINKS_LOCAL_TOKEN_KEY";
const LOCAL_TOKEN_HINT =
  `Local tokens from another smartlinks run invocation require the same ${LOCAL_TOKEN_KEY_ENV}; ` +
  "also check that the script and token context are unchanged.";

type LocalTokenConfiguration = {
  masterSecret: string;
  openFailureHint: string;
};

function localTokenConfiguration(): LocalTokenConfiguration {
  const configured = process.env[LOCAL_TOKEN_KEY_ENV];
  if (configured === undefined) {
    return { masterSecret: ephemeralMasterSecret, openFailureHint: LOCAL_TOKEN_HINT };
  }
  if (utf8(configured).byteLength < MIN_TOKEN_KEY_BYTES) {
    throw new Error(`${LOCAL_TOKEN_KEY_ENV} must contain at least ${MIN_TOKEN_KEY_BYTES} bytes.`);
  }
  return { masterSecret: configured, openFailureHint: LOCAL_TOKEN_HINT };
}

type LocalProgram = {
  source: string;
  closures: readonly string[];
  context: SandboxContext;
  simulation?: LocalSimulation;
};

type LocalRuntimeOptions = {
  allowNetwork: boolean;
  blockedHostnames: readonly string[];
  service?: string;
};

type LocalExecutionEnvironment = {
  createGuestFetch: () => GuestFetch;
  getLocalKey: () => Promise<GeneratedKeyPair>;
  randomBytes: GuestRandomBytes | undefined;
  simulation?: LocalSimulation;
  token: LocalTokenConfiguration;
};

async function decryptSecrets(
  decoded: DecodedPayload,
  getLocalKey: () => Promise<GeneratedKeyPair>,
): Promise<Record<string, string>> {
  const sealed = boundSealedSecrets(decoded);
  if (!sealed.length) {
    return {};
  }
  const localKey = await getLocalKey();

  return Object.fromEntries(
    await Promise.all(
      sealed.map(async ({ name, blob, binding }) => {
        if (sealedSecretKeyId(blob) !== localKey.keyId) {
          throw new Error("The compiled local Smartlink requires a different encryption key.");
        }
        return [name, await openSecret(blob, binding, localKey.privateKeySecret)] as const;
      }),
    ),
  );
}

async function execute(
  decoded: DecodedPayload,
  context: SandboxContext,
  environment: LocalExecutionEnvironment,
  service: string,
  compileHop: number,
): Promise<ScriptResult> {
  const cryptoBudget = createCryptoOperationBudget();
  const simulation = environment.simulation;

  return runScript({
    version: decoded.version,
    source: decoded.envelope.s,
    context,
    fetch: environment.createGuestFetch(),
    crypto: createGuestCrypto({
      crypto,
      budget: cryptoBudget,
      tokenKeySource: {
        masterSecret: environment.token.masterSecret,
        artifactIdentity: payloadArtifactIdentity(decoded),
        domain: "local",
      },
      tokenOpenFailureHint: environment.token.openFailureHint,
      ...(environment.randomBytes ? { randomBytes: environment.randomBytes } : {}),
    }),
    cryptoBudget,
    compile: createSmartlinkCompiler({
      parent: decoded,
      parentSecrets: context.secrets,
      service,
      getPublicKey: environment.getLocalKey,
      encode: async (envelope, version) => {
        const payload = await encodePayloadForCli(envelope, version);
        simulation?.recordCompile({ version, envelope }, payload.length, compileHop);
        return payload;
      },
      validate: async (version, childSource) => validateScript(version, childSource),
      cryptoBudget,
    }),
  });
}

function compiledUrl(result: ScriptResult, service: string): URL | undefined {
  if (typeof result !== "string") {
    return undefined;
  }
  try {
    const url = new URL(result);
    return url.origin === service && /^\/r\/[^/]+$/u.test(url.pathname) ? url : undefined;
  } catch {
    return undefined;
  }
}

export type LocalRuntime = {
  executePayload(payload: string, context: Omit<SandboxContext, "secrets">): Promise<ScriptResult>;
  executeProgram(program: LocalProgram): Promise<ScriptResult>;
};

export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntime {
  const service = options.service ?? LOCAL_SERVICE_URL;
  const nodeFetch = options.allowNetwork ? createNodeFetch() : undefined;
  let localKey: Promise<GeneratedKeyPair> | undefined;
  const getLocalKey = () => {
    localKey ??= generateKeyPair(1);
    return localKey;
  };
  const token = localTokenConfiguration();

  const executionEnvironment = (simulation?: LocalSimulation): LocalExecutionEnvironment => {
    if (options.allowNetwork && simulation) {
      throw new Error("Network access and network simulation cannot be enabled together.");
    }
    const createGuestFetch = (): GuestFetch =>
      simulation
        ? simulation.createGuestFetch(options.blockedHostnames)
        : nodeFetch
          ? createGuardedFetch({
              fetchImpl: nodeFetch,
              blockedHostnames: options.blockedHostnames,
            })
          : async () => {
              throw new Error(
                "Network access is disabled. Re-run with --allow-network to enable fetch.",
              );
            };
    const randomBytes = simulation
      ? (byteCount: number) => simulation.randomBytes(byteCount)
      : undefined;
    return {
      createGuestFetch,
      getLocalKey,
      randomBytes,
      ...(simulation ? { simulation } : {}),
      token,
    };
  };

  const executeChain = async (
    initialDecoded: DecodedPayload,
    initialContext: SandboxContext,
    simulation?: LocalSimulation,
  ): Promise<ScriptResult> => {
    const environment = executionEnvironment(simulation);
    let decoded = initialDecoded;
    let context = initialContext;
    let result = await execute(decoded, context, environment, service, 1);

    for (let followed = 0; ; followed += 1) {
      const url = compiledUrl(result, service);
      if (!url) {
        return result;
      }
      if (followed >= MAX_COMPILE_REDIRECTS) {
        throw new Error(
          `Local execution followed more than ${MAX_COMPILE_REDIRECTS} compiled Smartlinks.`,
        );
      }
      const payload = payloadFromInput(url.href);
      decoded = decodePayload(payload);
      if (isExpired(decoded.envelope.notAfter)) {
        throw new Error("The compiled local Smartlink has expired.");
      }
      const secrets = await decryptSecrets(decoded, getLocalKey);
      simulation?.addSecrets(secrets);
      context = {
        params: userParams(url.searchParams),
        paramValues: userParamValues(url.searchParams),
        method: "GET",
        headers: {},
        body: null,
        secrets,
        requestId: createRequestId(),
      };
      result = await execute(decoded, context, environment, service, followed + 2);
    }
  };

  return {
    async executePayload(payload, context) {
      const decoded = decodePayload(payload);
      if (isExpired(decoded.envelope.notAfter)) {
        throw new Error("The compiled local Smartlink has expired.");
      }
      return executeChain(decoded, {
        ...context,
        secrets: await decryptSecrets(decoded, getLocalKey),
      });
    },
    executeProgram(program) {
      return executeChain(
        {
          version: "2",
          envelope: {
            s: program.source,
            ...(program.closures.length ? { c: [...program.closures] } : {}),
          },
        },
        program.context,
        program.simulation,
      );
    },
  };
}

export async function runLocalProgram(
  program: LocalProgram & LocalRuntimeOptions,
): Promise<ScriptResult> {
  if (program.allowNetwork && program.simulation) {
    throw new Error("Network access and network simulation cannot be enabled together.");
  }
  return createLocalRuntime(program).executeProgram(program);
}
