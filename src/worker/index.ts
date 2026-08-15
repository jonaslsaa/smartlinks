import { ZodError } from "zod";
import { isPreviewRequest } from "../shared/bots.js";
import { type DecodedPayload, isExpired } from "../shared/codec.js";
import { createGuardedFetch } from "../shared/guarded-fetch.js";
import { createCryptoOperationBudget, createGuestCrypto } from "../shared/guest-crypto.js";
import { createSmartlinkCompiler } from "../shared/mint.js";
import {
  createRequestId,
  lowercaseHeaders,
  userParams,
  userParamValues,
} from "../shared/request-context.js";
import {
  InvalidScriptResponseError,
  mapScriptResult,
  type ScriptResult,
} from "../shared/result.js";
import {
  boundSealedSecrets,
  openSecret,
  publicKeyFromPrivateSecret,
  sealedSecretKeyId,
} from "../shared/seal.js";
import { decodeWorkerPayload, encodeWorkerPayload } from "./codec.js";
import { HttpError, json, readBoundedBody } from "./http.js";
import { decoderPage, expiredPage, interstitialPage, previewPage } from "./pages.js";
import { runWorkerScript, validateWorkerScript } from "./sandbox.js";

function readStringBinding(env: Env, name: string): string | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(env, name)?.value;
  return typeof value === "string" ? value : undefined;
}

function keyIdFromEnv(env: Env): number {
  const keyId = Number(env.ACTIVE_KEY_ID);
  if (!Number.isInteger(keyId) || keyId < 1 || keyId > 255) {
    throw new HttpError(503, "The service encryption key is not configured.");
  }
  return keyId;
}

function privateKey(env: Env, keyId: number): string {
  const secret = readStringBinding(env, `PRIVATE_KEY_${keyId}`);
  if (!secret) {
    throw new HttpError(503, `Encryption key ${keyId} is unavailable.`);
  }
  return secret;
}

function routePayload(pathname: string, route: "r" | "d"): string | undefined {
  const prefix = `/${route}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const payload = pathname.slice(prefix.length);
  return payload && !payload.includes("/") ? payload : undefined;
}

async function decryptSecrets(decoded: DecodedPayload, env: Env): Promise<Record<string, string>> {
  if (!decoded.envelope.k) {
    return {};
  }
  let sealed: ReturnType<typeof boundSealedSecrets>;
  try {
    sealed = boundSealedSecrets(decoded);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid sealed secrets.", {
      cause: error,
    });
  }

  const entries = await Promise.all(
    sealed.map(async ({ name, blob, binding }) => {
      const keyId = sealedSecretKeyId(blob);
      try {
        return [name, await openSecret(blob, binding, privateKey(env, keyId))] as const;
      } catch (error) {
        if (error instanceof HttpError) {
          throw error;
        }
        throw new HttpError(400, `Sealed secret ${name} could not be decrypted.`, { cause: error });
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function enforceExecutionRateLimit(request: Request, env: Env): Promise<void> {
  const key = request.headers.get("cf-connecting-ip") ?? "unknown-client";
  const { success } = await env.EXECUTION_RATE_LIMITER.limit({ key });
  if (!success) {
    throw new HttpError(429, "Too many Smartlink executions. Try again shortly.", {
      headers: { "retry-after": "60" },
    });
  }
}

async function runRoute(request: Request, env: Env, payload: string): Promise<Response> {
  if (isPreviewRequest(request)) {
    return previewPage(request.method === "HEAD");
  }

  let decoded: DecodedPayload;
  try {
    decoded = await decodeWorkerPayload(payload);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid smartlink.", {
      cause: error,
    });
  }

  const url = new URL(request.url);
  if (isExpired(decoded.envelope.notAfter)) {
    return expiredPage();
  }
  if (decoded.envelope.i) {
    if (request.method === "GET") {
      const action = new URL(url);
      action.searchParams.set("__confirm", "1");
      return interstitialPage(decoded, `${action.pathname}${action.search}`);
    }
    if (request.method !== "POST" || url.searchParams.get("__confirm") !== "1") {
      throw new HttpError(405, "This smartlink requires browser confirmation.");
    }
  }

  await enforceExecutionRateLimit(request, env);
  const secrets = await decryptSecrets(decoded, env);
  const cryptoBudget = createCryptoOperationBudget();
  const compile = createSmartlinkCompiler({
    parent: decoded,
    parentSecrets: secrets,
    service: url.origin,
    getPublicKey: () => {
      const keyId = keyIdFromEnv(env);
      return publicKeyFromPrivateSecret(keyId, privateKey(env, keyId));
    },
    encode: encodeWorkerPayload,
    validate: validateWorkerScript,
    cryptoBudget,
  });
  let result: ScriptResult;
  try {
    result = await runWorkerScript({
      version: decoded.version,
      source: decoded.envelope.s,
      context: {
        params: userParams(url.searchParams),
        paramValues: userParamValues(url.searchParams),
        method: request.method,
        headers: lowercaseHeaders(request.headers),
        body: await readBoundedBody(request),
        secrets,
        requestId: createRequestId(request.headers.get("cf-ray")),
      },
      fetch: createGuardedFetch(),
      crypto: createGuestCrypto(crypto, cryptoBudget),
      cryptoBudget,
      compile,
    });
  } catch (error) {
    if (error instanceof InvalidScriptResponseError) {
      throw new HttpError(422, error.message, { cause: error });
    }
    throw new HttpError(422, "The smartlink script failed.", { cause: error });
  }

  try {
    return mapScriptResult(result);
  } catch (error) {
    if (error instanceof InvalidScriptResponseError) {
      throw new HttpError(422, error.message, { cause: error });
    }
    throw new HttpError(422, "The smartlink returned an invalid response.", { cause: error });
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed.");
    }
    return new Response(null, {
      status: 302,
      headers: {
        "cache-control": "no-store",
        location: env.LANDING_URL,
      },
    });
  }

  if (url.pathname === "/pk") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed.");
    }
    const keyId = keyIdFromEnv(env);
    const key = publicKeyFromPrivateSecret(keyId, privateKey(env, keyId));
    const response = json({ ...key, suite: "HPKE-X25519-HKDF-SHA256-AES128GCM" });
    return request.method === "HEAD" ? new Response(null, response) : response;
  }

  const runnerPayload = routePayload(url.pathname, "r");
  if (runnerPayload) {
    return runRoute(request, env, runnerPayload);
  }

  const decoderPayload = routePayload(url.pathname, "d");
  if (decoderPayload) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed.");
    }
    let decoded: DecodedPayload;
    try {
      decoded = await decodeWorkerPayload(decoderPayload);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid smartlink.", {
        cause: error,
      });
    }
    const response = decoderPage(decoded);
    return request.method === "HEAD" ? new Response(null, response) : response;
  }

  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const status =
        error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500;
      const message =
        status < 500 && error instanceof Error ? error.message : "Internal server error.";
      if (status >= 500) {
        console.error(
          JSON.stringify({
            message: "request failed",
            error: error instanceof Error ? error.name : "UnknownError",
            route: new URL(request.url).pathname.split("/").slice(0, 2).join("/") || "/",
          }),
        );
      }
      const responseInit: ResponseInit = { status };
      if (error instanceof HttpError) {
        responseInit.headers = error.headers;
      }
      return json({ error: message }, responseInit);
    }
  },
} satisfies ExportedHandler<Env>;
