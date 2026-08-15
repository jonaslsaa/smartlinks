import { toBase64Url } from "../shared/bytes.js";
import {
  type DecodedPayload,
  decodePayload,
  isExpired,
  payloadFromInput,
} from "../shared/codec.js";
import { createGuardedFetch, type GuestFetch } from "../shared/guarded-fetch.js";
import { createCryptoOperationBudget, createGuestCrypto } from "../shared/guest-crypto.js";
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
const masterSecret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

type LocalProgram = {
  source: string;
  closures: readonly string[];
  context: SandboxContext;
  allowNetwork: boolean;
  blockedHostnames: readonly string[];
  simulation?: LocalSimulation;
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
  createGuestFetch: () => GuestFetch,
  getLocalKey: () => Promise<GeneratedKeyPair>,
): Promise<ScriptResult> {
  const cryptoBudget = createCryptoOperationBudget();
  return runScript({
    version: decoded.version,
    source: decoded.envelope.s,
    context,
    fetch: createGuestFetch(),
    crypto: createGuestCrypto(crypto, cryptoBudget, {
      masterSecret,
      artifactIdentity: payloadArtifactIdentity(decoded),
    }),
    cryptoBudget,
    compile: createSmartlinkCompiler({
      parent: decoded,
      parentSecrets: context.secrets,
      service: LOCAL_SERVICE_URL,
      getPublicKey: getLocalKey,
      encode: async (envelope, version) => encodePayloadForCli(envelope, version),
      validate: async (version, childSource) => validateScript(version, childSource),
      cryptoBudget,
    }),
  });
}

function compiledUrl(result: ScriptResult): URL | undefined {
  if (typeof result !== "string") {
    return undefined;
  }
  try {
    const url = new URL(result);
    return url.origin === LOCAL_SERVICE_URL && /^\/r\/[^/]+$/u.test(url.pathname) ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function runLocalProgram(program: LocalProgram): Promise<ScriptResult> {
  if (program.allowNetwork && program.simulation) {
    throw new Error("Network access and network simulation cannot be enabled together.");
  }
  const nodeFetch = program.allowNetwork ? createNodeFetch() : undefined;
  const createGuestFetch = (): GuestFetch =>
    program.simulation
      ? program.simulation.createGuestFetch(program.blockedHostnames)
      : nodeFetch
        ? createGuardedFetch({ fetchImpl: nodeFetch, blockedHostnames: program.blockedHostnames })
        : async () => {
            throw new Error(
              "Network access is disabled. Re-run with --allow-network to enable fetch.",
            );
          };
  let localKey: Promise<GeneratedKeyPair> | undefined;
  const getLocalKey = () => {
    localKey ??= generateKeyPair(1);
    return localKey;
  };
  let decoded: DecodedPayload = {
    version: "2",
    envelope: {
      s: program.source,
      ...(program.closures.length ? { c: [...program.closures] } : {}),
    },
  };
  let context = program.context;
  let result = await execute(decoded, context, createGuestFetch, getLocalKey);

  for (let followed = 0; ; followed += 1) {
    const url = compiledUrl(result);
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
    program.simulation?.recordCompile(decoded, payload.length, followed + 1);
    if (isExpired(decoded.envelope.notAfter)) {
      throw new Error("The compiled local Smartlink has expired.");
    }
    const secrets = await decryptSecrets(decoded, getLocalKey);
    program.simulation?.addSecrets(secrets);
    context = {
      params: userParams(url.searchParams),
      paramValues: userParamValues(url.searchParams),
      method: "GET",
      headers: {},
      body: null,
      secrets,
      requestId: createRequestId(),
    };
    result = await execute(decoded, context, createGuestFetch, getLocalKey);
  }
}
