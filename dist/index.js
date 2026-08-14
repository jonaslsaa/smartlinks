#!/usr/bin/env node

// src/cli/index.ts
import { spawn } from "child_process";
import { webcrypto } from "crypto";
import { readFile } from "fs/promises";
import * as p3 from "@clack/prompts";
import clipboard from "clipboardy";
import { Command, Option } from "commander";
import { z as z5 } from "zod";

// src/shared/codec.ts
import { deflateSync, Inflate } from "fflate";
import { z } from "zod";

// src/shared/bytes.ts
function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
function toBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error("Expected an unpadded base64url value.");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function utf8(value) {
  return new TextEncoder().encode(value);
}
function text(bytes) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

// src/shared/codec.ts
var CURRENT_PAYLOAD_VERSION = "2";
var MAX_PAYLOAD_LENGTH = 7800;
var MAX_SCRIPT_LENGTH = 32e3;
var MAX_DECOMPRESSED_LENGTH = 64e3;
var SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
var sealedSecretSchema = z.record(
  z.string().regex(SECRET_NAME, "Secret names must look like environment variables."),
  z.string().min(1).max(2048)
);
var envelopeSchema = z.object({
  s: z.string().min(1).max(MAX_SCRIPT_LENGTH),
  i: z.literal(true).optional(),
  k: sealedSecretSchema.optional()
}).strict();
function inflateWithLimit(compressed) {
  const chunks = [];
  let length = 0;
  const inflate = new Inflate((chunk) => {
    length += chunk.byteLength;
    if (length > MAX_DECOMPRESSED_LENGTH) {
      throw new Error("The decoded payload is too large.");
    }
    chunks.push(chunk);
  });
  for (let offset2 = 0; offset2 < compressed.byteLength; offset2 += 256) {
    const end = Math.min(offset2 + 256, compressed.byteLength);
    inflate.push(compressed.subarray(offset2, end), end === compressed.byteLength);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
function encodePayload(input, version = CURRENT_PAYLOAD_VERSION) {
  const envelope = envelopeSchema.parse(input);
  const json = JSON.stringify(envelope);
  const compressed = deflateSync(utf8(json), { level: 9 });
  const payload = `${version}${toBase64Url(compressed)}`;
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(
      `The encoded payload is ${payload.length.toLocaleString()} characters; the limit is ${MAX_PAYLOAD_LENGTH.toLocaleString()}.`
    );
  }
  return payload;
}
function decodePayload(payload) {
  if (payload.length < 2 || payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error("The payload length is invalid.");
  }
  const version = payload[0];
  if (version !== "1" && version !== "2") {
    throw new Error(`Unsupported payload version: ${version ?? "missing"}.`);
  }
  try {
    const compressed = fromBase64Url(payload.slice(1));
    const json = text(inflateWithLimit(compressed));
    return { version, envelope: envelopeSchema.parse(JSON.parse(json)) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported payload version")) {
      throw error;
    }
    throw new Error("The smartlink payload is invalid or corrupted.", { cause: error });
  }
}
function payloadFromInput(input) {
  const trimmed = input.trim();
  if (/^[12][A-Za-z0-9_-]+$/u.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/r\/([^/]+)$/u) ?? url.pathname.match(/\/d\/([^/]+)$/u);
    if (!match?.[1]) {
      throw new Error("missing payload path");
    }
    return match[1];
  } catch (error) {
    throw new Error("Expected a smartlink URL or encoded payload.", { cause: error });
  }
}

// src/shared/guarded-fetch.ts
import ipaddr from "ipaddr.js";
import { z as z2 } from "zod";
var MAX_FETCHES = 5;
var MAX_FETCH_RESPONSE_BYTES = 1048576;
var MAX_FETCH_REQUEST_BYTES = 1048576;
var MAX_HEADER_BYTES = 16384;
var FETCH_TIMEOUT_MS = 1e4;
var MAX_REDIRECTS = 3;
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var encoder = new TextEncoder();
var fetchOptionsSchema = z2.object({
  method: z2.string().regex(/^[A-Za-z]+$/u).max(16).optional(),
  headers: z2.record(z2.string().max(256), z2.string().max(8192)).optional(),
  body: z2.string().optional()
}).strict();
function normalizeHostname(hostname) {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}
function assertPublicIpAddress(address) {
  if (!ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast") {
    throw new Error("Fetches to private, local, or reserved IP addresses are blocked.");
  }
}
function assertPublicUrl(input) {
  if (input.length > 4096) {
    throw new Error("Fetch URL is too long.");
  }
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error("ctx.fetch requires an absolute URL.", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ctx.fetch only supports http: and https: URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials are not allowed in fetch URLs.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new Error("Fetches to local hostnames are blocked.");
  }
  if (ipaddr.isValid(hostname)) {
    assertPublicIpAddress(hostname);
  }
  return url;
}
async function readResponseText(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_FETCH_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Fetch response exceeds the 1 MB limit.");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_FETCH_RESPONSE_BYTES) {
        throw new Error("Fetch response exceeds the 1 MB limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => void 0);
    throw error;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
function createGuardedFetch(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFetches = options.maxFetches ?? MAX_FETCHES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let fetchCount = 0;
  return async (input, rawOptions) => {
    const parsedOptions = fetchOptionsSchema.parse(rawOptions ?? {});
    let method = (parsedOptions.method ?? "GET").toUpperCase();
    if (method === "CONNECT" || method === "TRACE") {
      throw new Error(`${method} requests are blocked.`);
    }
    if ((method === "GET" || method === "HEAD") && parsedOptions.body !== void 0) {
      throw new Error(`${method} requests cannot include a body.`);
    }
    if (parsedOptions.body !== void 0 && encoder.encode(parsedOptions.body).byteLength > MAX_FETCH_REQUEST_BYTES) {
      throw new Error("Fetch request body exceeds the 1 MB limit.");
    }
    const headers = new Headers();
    let headerBytes = 0;
    for (const [name, value] of Object.entries(parsedOptions.headers ?? {})) {
      headerBytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
      if (headerBytes > MAX_HEADER_BYTES) {
        throw new Error("Fetch headers exceed the 16 KB limit.");
      }
      const lowerName = name.toLowerCase();
      if (lowerName === "host" || lowerName === "connection" || lowerName === "content-length" || lowerName === "transfer-encoding" || lowerName.startsWith("cf-") || lowerName.startsWith("x-forwarded-")) {
        continue;
      }
      headers.set(name, value);
    }
    let url = assertPublicUrl(input);
    let body = parsedOptions.body;
    for (let redirects = 0; ; redirects += 1) {
      fetchCount += 1;
      if (fetchCount > maxFetches) {
        throw new Error(`A script may make at most ${maxFetches} fetch requests.`);
      }
      const response = await fetchImpl(url, {
        method,
        headers,
        ...body === void 0 ? {} : { body },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) {
          throw new Error("Fetch redirect did not include a Location header.");
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Fetch exceeded the ${MAX_REDIRECTS} redirect limit.`);
        }
        const nextUrl = assertPublicUrl(new URL(location, url).href);
        if (nextUrl.origin !== url.origin) {
          throw new Error("Cross-origin fetch redirects are blocked.");
        }
        if (response.status === 303 || (response.status === 301 || response.status === 302) && method === "POST") {
          method = "GET";
          body = void 0;
          headers.delete("content-type");
          headers.delete("content-encoding");
          headers.delete("content-language");
          headers.delete("content-location");
        }
        url = nextUrl;
        continue;
      }
      const responseHeaders = {};
      for (const [name, value] of response.headers) {
        responseHeaders[name] = value;
      }
      return {
        status: response.status,
        headers: responseHeaders,
        text: await readResponseText(response)
      };
    }
  };
}

// src/shared/request-context.ts
function userParams(entries) {
  const params = {};
  for (const [name, value] of entries) {
    if (!name.startsWith("__")) {
      params[name] = value;
    }
  }
  return params;
}
function lowercaseHeaders(entries, rejectDuplicates = false) {
  const headers = {};
  for (const [name, value] of entries) {
    const normalizedName = name.toLowerCase();
    if (rejectDuplicates && normalizedName in headers) {
      throw new Error(`Header ${normalizedName} was provided more than once.`);
    }
    headers[normalizedName] = value;
  }
  return headers;
}
function localRequestBody(method, body) {
  if (method === "GET" || method === "HEAD") {
    if (body !== void 0) {
      throw new Error(`${method} requests cannot include a body.`);
    }
    return null;
  }
  return body ?? null;
}

// src/shared/result.ts
import { z as z3 } from "zod";
var literalResponseSchema = z3.object({
  status: z3.number().int().min(200).max(599).optional(),
  headers: z3.record(z3.string(), z3.string()).optional(),
  body: z3.string().optional()
}).strict();
function parseScriptResult(input) {
  if (input === void 0 || typeof input === "string") {
    return input;
  }
  return literalResponseSchema.parse(input);
}
function mapScriptResult(input) {
  const result = parseScriptResult(input);
  if (result === void 0) {
    return new Response("<!doctype html><title>Done</title><p>\u2713 done</p>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  if (typeof result === "string") {
    let url;
    try {
      url = new URL(result);
    } catch (error) {
      throw new Error("A string result must be an absolute URL.", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("A redirect result must use http: or https:.");
    }
    return Response.redirect(url.href, 302);
  }
  const headers = new Headers(result.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const status = result.status ?? 200;
  const body = status === 204 || status === 205 || status === 304 ? null : result.body ?? "";
  return new Response(body, { status, headers });
}

// src/shared/sandbox.ts
import {
  newQuickJSWASMModuleFromVariant
} from "quickjs-emscripten-core";
import { z as z4 } from "zod";

// src/shared/script.ts
import { parse } from "acorn";
import { generate } from "astring";
import { minify } from "terser";
async function minifyScriptBody(source) {
  const wrapped = wrapScriptBody(source);
  const result = await minify(wrapped, {
    compress: { passes: 2, side_effects: false },
    mangle: true,
    ecma: 2022,
    format: { comments: false, semicolons: true }
  });
  const code = result.code?.replace(/;$/u, "");
  if (!code) {
    throw new Error("The script could not be minified.");
  }
  return code;
}
function wrapScriptBody(source) {
  if (!source.trim()) {
    throw new Error("The script is empty.");
  }
  if (source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `The script exceeds the ${MAX_SCRIPT_LENGTH.toLocaleString()} character limit.`
    );
  }
  return `async ctx=>{${source}
}`;
}
function executableSource(version, storedSource) {
  return version === "1" ? `(async (ctx) => {${storedSource}
})(globalThis.__smartlinks_ctx)` : `(${storedSource})(globalThis.__smartlinks_ctx)`;
}
function formatStoredScript(version, storedSource) {
  if (version === "1") {
    return storedSource;
  }
  try {
    const program2 = parse(`(${storedSource})`, { ecmaVersion: "latest" });
    return generate(program2).trim();
  } catch {
    return storedSource;
  }
}

// src/shared/sandbox.ts
var MAX_MEMORY_BYTES = 16 * 1024 * 1024;
var MAX_STACK_BYTES = 512 * 1024;
var MAX_INTERRUPT_TICKS = 1500;
var MAX_EXECUTION_MS = 15e3;
var sandboxContextSchema = z4.object({
  params: z4.record(z4.string(), z4.string()),
  method: z4.string(),
  headers: z4.record(z4.string(), z4.string()),
  body: z4.string().nullable(),
  secrets: z4.record(z4.string(), z4.string())
});
var defaultQuickJsModule;
function getDefaultQuickJsModule() {
  defaultQuickJsModule ??= newQuickJSWASMModuleFromVariant(
    import("@jitl/quickjs-wasmfile-release-sync")
  );
  return defaultQuickJsModule;
}
function errorMessage(vm, handle) {
  const value = vm.dump(handle);
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = value.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "The script failed inside the sandbox.";
}
function jsonHandle(vm, value) {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) {
    return vm.undefined;
  }
  return vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(serialized)})`));
}
async function runScript(options) {
  return runScriptWithModule(options, getDefaultQuickJsModule());
}
async function validateScript(version, source) {
  return validateScriptWithModule(version, source, getDefaultQuickJsModule());
}
async function validateScriptWithModule(version, source, quickJsModule) {
  const module = await quickJsModule;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const vm = runtime.newContext();
  try {
    const compiled = vm.evalCode(executableSource(version, source), "smartlink.js", {
      compileOnly: true
    });
    if (compiled.error) {
      const message = errorMessage(vm, compiled.error);
      compiled.error.dispose();
      throw new Error(`The script does not compile in QuickJS: ${message}`);
    }
    compiled.value.dispose();
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
async function runScriptWithModule(options, quickJsModule) {
  const module = await quickJsModule;
  const timeoutMs = options.timeoutMs ?? MAX_EXECUTION_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The script timeout must be a positive number.");
  }
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  let interruptTicks = 0;
  runtime.setInterruptHandler(() => {
    interruptTicks += 1;
    return interruptTicks > MAX_INTERRUPT_TICKS;
  });
  const vm = runtime.newContext();
  const pendingDeferreds = /* @__PURE__ */ new Set();
  const pendingHostCalls = /* @__PURE__ */ new Set();
  let promiseHandle;
  let executionTimer;
  const timedOut = new Promise((_resolve, reject) => {
    executionTimer = setTimeout(
      () => reject(new Error(`Script execution exceeded ${timeoutMs.toLocaleString()} ms.`)),
      timeoutMs
    );
  });
  const executePendingJobs = () => {
    const executed = runtime.executePendingJobs();
    if (executed.error) {
      const message = errorMessage(executed.error.context, executed.error);
      executed.dispose();
      throw new Error(message);
    }
    executed.dispose();
  };
  try {
    const initialContext = sandboxContextSchema.parse(options.context);
    const contextHandle = jsonHandle(vm, initialContext);
    const fetchHandle = vm.newFunction("fetch", (urlHandle, optionsHandle) => {
      const url = vm.getString(urlHandle);
      const rawOptions = optionsHandle ? vm.dump(optionsHandle) : void 0;
      const deferred = vm.newPromise();
      pendingDeferreds.add(deferred);
      const rejectDeferred = (error) => {
        if (!deferred.alive) {
          return;
        }
        const message = error instanceof Error ? error.message : "Fetch failed.";
        const errorHandle = vm.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      };
      let hostCall;
      hostCall = options.fetch(url, rawOptions).then((result) => {
        if (!deferred.alive) {
          return;
        }
        interruptTicks = 0;
        try {
          const resultHandle = jsonHandle(vm, result);
          deferred.resolve(resultHandle);
          resultHandle.dispose();
        } catch (error) {
          rejectDeferred(error);
        }
      }, rejectDeferred).finally(() => {
        pendingDeferreds.delete(deferred);
        pendingHostCalls.delete(hostCall);
      });
      pendingHostCalls.add(hostCall);
      return deferred.handle;
    });
    vm.setProp(contextHandle, "fetch", fetchHandle);
    vm.setProp(vm.global, "__smartlinks_ctx", contextHandle);
    fetchHandle.dispose();
    contextHandle.dispose();
    const evaluated = vm.evalCode(
      executableSource(options.version, options.source),
      "smartlink.js"
    );
    if (evaluated.error) {
      const message = errorMessage(vm, evaluated.error);
      evaluated.error.dispose();
      throw new Error(message);
    }
    promiseHandle = evaluated.value;
    while (true) {
      executePendingJobs();
      const state = vm.getPromiseState(promiseHandle);
      if (state.type === "fulfilled") {
        const dumped = vm.dump(state.value);
        state.value.dispose();
        return parseScriptResult(dumped);
      }
      if (state.type === "rejected") {
        const message = errorMessage(vm, state.error);
        state.error.dispose();
        throw new Error(message);
      }
      if (pendingHostCalls.size === 0) {
        throw new Error("The script returned a promise that cannot make progress.");
      }
      await Promise.race([Promise.race(pendingHostCalls), timedOut]);
    }
  } finally {
    if (executionTimer !== void 0) {
      clearTimeout(executionTimer);
    }
    for (const deferred of pendingDeferreds) {
      deferred.dispose();
    }
    if (promiseHandle?.alive) {
      promiseHandle.dispose();
    }
    vm.dispose();
    runtime.dispose();
  }
}

// src/shared/seal.ts
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
var suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm()
});
var HPKE_INFO = utf8("smartlinks/hpke/v1");
function assertKeyId(keyId) {
  if (!Number.isInteger(keyId) || keyId < 1 || keyId > 255) {
    throw new Error("The key ID must be an integer between 1 and 255.");
  }
}
async function aad(keyId, script) {
  const scriptHash = await crypto.subtle.digest("SHA-256", Uint8Array.from(utf8(script)).buffer);
  return concatBytes(Uint8Array.of(keyId), new Uint8Array(scriptHash));
}
async function generateKeyPair(keyId) {
  assertKeyId(keyId);
  const pair = await suite.kem.generateKeyPair();
  const [privateKey, publicKey] = await Promise.all([
    suite.kem.serializePrivateKey(pair.privateKey),
    suite.kem.serializePublicKey(pair.publicKey)
  ]);
  const encodedPublicKey = toBase64Url(publicKey);
  return {
    keyId,
    publicKey: encodedPublicKey,
    privateKeySecret: `${toBase64Url(privateKey)}.${encodedPublicKey}`
  };
}
async function sealSecret(plaintext, script, recipient) {
  assertKeyId(recipient.keyId);
  const publicKey = await suite.kem.deserializePublicKey(fromBase64Url(recipient.publicKey));
  const sealed = await suite.seal(
    { recipientPublicKey: publicKey, info: HPKE_INFO },
    utf8(plaintext),
    await aad(recipient.keyId, script)
  );
  return toBase64Url(
    concatBytes(
      Uint8Array.of(recipient.keyId),
      new Uint8Array(sealed.enc),
      new Uint8Array(sealed.ct)
    )
  );
}

// src/cli/build.ts
async function createSmartlink(options) {
  const source = options.minify === false ? wrapScriptBody(options.source) : await minifyScriptBody(options.source);
  await (options.validate ?? validateScript)("2", source);
  const secretEntries = Object.entries(options.secrets ?? {});
  if (secretEntries.length > 0 && !options.publicKey) {
    throw new Error("A service public key is required to seal secrets.");
  }
  const publicKey = options.publicKey;
  const sealedEntries = publicKey ? await Promise.all(
    secretEntries.map(
      async ([name, value]) => [name, await sealSecret(value, source, publicKey)]
    )
  ) : [];
  const payload = encodePayload({
    s: source,
    ...options.interstitial ? { i: true } : {},
    ...sealedEntries.length ? { k: Object.fromEntries(sealedEntries) } : {}
  });
  return {
    payload,
    source,
    link: `${options.service}/r/${payload}`,
    decoder: `${options.service}/d/${payload}`
  };
}

// src/cli/node-fetch.ts
import { lookup } from "dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
var resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true });
function publicLookup(resolve) {
  return (hostname, options, callback) => {
    void resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new Error(`DNS returned no addresses for ${hostname}.`), "", 0);
          return;
        }
        try {
          for (const address of addresses) {
            assertPublicIpAddress(address.address);
          }
        } catch (error) {
          callback(error instanceof Error ? error : new Error("DNS address was rejected."), "", 0);
          return;
        }
        if (options.all) {
          callback(null, [...addresses]);
          return;
        }
        const first = addresses[0];
        if (!first) {
          callback(new Error(`DNS returned no addresses for ${hostname}.`), "", 0);
          return;
        }
        callback(null, first.address, first.family);
      },
      (error) => {
        callback(error instanceof Error ? error : new Error("DNS lookup failed."), "", 0);
      }
    );
  };
}
async function assertPublicHostname(hostname, resolve) {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${hostname}.`);
  }
  for (const address of addresses) {
    assertPublicIpAddress(address.address);
  }
}
function createNodeFetch(resolve = resolveHost) {
  const dispatcher = new Agent({ connect: { lookup: publicLookup(resolve) } });
  return async (input, init) => {
    await assertPublicHostname(input.hostname, resolve);
    if (init.body !== void 0 && init.body !== null && typeof init.body !== "string") {
      throw new Error("The Node fetch bridge only supports string request bodies.");
    }
    const response = await undiciFetch(input, {
      ...init.method === void 0 ? {} : { method: init.method },
      headers: Object.fromEntries(new Headers(init.headers)),
      ...typeof init.body === "string" ? { body: init.body } : {},
      ...init.redirect === void 0 ? {} : { redirect: init.redirect },
      ...init.signal === void 0 || init.signal === null ? {} : { signal: init.signal },
      dispatcher
    });
    return response;
  };
}

// src/cli/ui.ts
import * as p from "@clack/prompts";
function startUi(title, json) {
  const interactive = process.stdout.isTTY && !json;
  if (interactive) {
    p.intro(title);
  }
  return interactive;
}
function fail(error) {
  const message = error instanceof Error ? error.message : "Unknown error.";
  console.error(`Error: ${message}`);
}

// src/cli/values.ts
import * as p2 from "@clack/prompts";
var SECRET_NAME2 = /^[A-Z][A-Z0-9_]{0,63}$/u;
function collect(value, previous) {
  return [...previous, value];
}
function splitAssignment(value, label) {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error(`${label} must use NAME=value.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}
function assignments(values, label) {
  const result = {};
  for (const value of values) {
    const [name, assignedValue] = splitAssignment(value, label);
    if (name in result) {
      throw new Error(`${label} ${name} was provided more than once.`);
    }
    result[name] = assignedValue;
  }
  return result;
}
async function resolveSecrets(values, options) {
  const secrets = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const name = separator === -1 ? value : value.slice(0, separator);
    if (!SECRET_NAME2.test(name)) {
      throw new Error(
        `Invalid secret name ${JSON.stringify(name)}. Use an uppercase environment name.`
      );
    }
    if (name in secrets) {
      throw new Error(`Secret ${name} was provided more than once.`);
    }
    if (separator !== -1) {
      secrets[name] = value.slice(separator + 1);
      continue;
    }
    const environmentValue = process.env[name];
    if (environmentValue !== void 0) {
      secrets[name] = environmentValue;
      continue;
    }
    if (!options.prompt || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Secret ${name} is not set in the environment and cannot be prompted for.`);
    }
    const prompted = await p2.password({
      message: `Value for ${name}`,
      validate: (input) => input ? void 0 : "A secret value is required."
    });
    if (p2.isCancel(prompted)) {
      throw new Error("Cancelled.");
    }
    secrets[name] = prompted;
  }
  return secrets;
}
function normalizeServiceUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error("The service must be an absolute URL.", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The service URL must use http: or https:.");
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/u, "");
}

// src/cli/index.ts
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}
var DEFAULT_SERVICE_URL = "https://smartlinks-runtime.jonasvox-2014.workers.dev";
var publicKeySchema = z5.object({
  keyId: z5.number().int().min(1).max(255),
  publicKey: z5.string().min(1)
});
async function fetchPublicKey(service) {
  let response;
  try {
    response = await fetch(`${service}/pk`, { signal: AbortSignal.timeout(1e4) });
  } catch (error) {
    throw new Error(
      `Could not reach ${service}/pk. Set --service or SMARTLINKS_URL to your deployed runtime.`,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new Error(`The service returned HTTP ${response.status} from /pk.`);
  }
  return publicKeySchema.parse(await response.json());
}
async function buildCommand(file, options) {
  const interactive = startUi("smartlinks build", options.json === true);
  const originalSource = await readFile(file, "utf8");
  const secrets = await resolveSecrets(options.secret, { prompt: interactive });
  const service = normalizeServiceUrl(
    options.service ?? process.env.SMARTLINKS_URL ?? DEFAULT_SERVICE_URL
  );
  let publicKey;
  if (Object.keys(secrets).length > 0) {
    const spinner2 = interactive ? p3.spinner() : void 0;
    spinner2?.start("Fetching public key and sealing secrets");
    publicKey = await fetchPublicKey(service);
    spinner2?.stop(`Fetched encryption key ${publicKey.keyId}`);
  }
  const created = await createSmartlink({
    source: originalSource,
    service,
    secrets,
    ...publicKey ? { publicKey } : {},
    ...options.interstitial ? { interstitial: true } : {},
    minify: options.minify
  });
  if (options.copy) {
    await clipboard.write(created.link);
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          link: created.link,
          decoder: created.decoder,
          characters: created.link.length,
          payloadVersion: 2
        },
        null,
        2
      )
    );
    return;
  }
  if (interactive) {
    p3.note(created.link, options.copy ? "Smartlink (copied)" : "Smartlink");
    p3.log.info(`Audit: ${created.decoder}`);
    p3.outro(`${created.link.length.toLocaleString()} characters \xB7 payload v2`);
  } else {
    console.log(created.link);
    console.error(`Audit: ${created.decoder}`);
    console.error(`${created.link.length.toLocaleString()} characters \xB7 payload v2`);
  }
}
async function decodeCommand(input, options) {
  const decoded = decodePayload(payloadFromInput(input));
  const script = formatStoredScript(decoded.version, decoded.envelope.s);
  const metadata = {
    payloadVersion: Number(decoded.version),
    interstitial: decoded.envelope.i === true,
    sealedSecrets: Object.keys(decoded.envelope.k ?? {})
  };
  if (options.json) {
    console.log(JSON.stringify({ ...metadata, script }, null, 2));
    return;
  }
  const interactive = startUi("smartlinks decode", false);
  if (interactive) {
    p3.note(script, "Script");
    p3.note(
      `Version: ${metadata.payloadVersion}
Confirmation: ${metadata.interstitial ? "yes" : "no"}
Sealed secrets: ${metadata.sealedSecrets.join(", ") || "none"}`,
      "Metadata"
    );
    p3.outro("Decoded without executing");
  } else {
    console.log(script);
    console.error(JSON.stringify(metadata));
  }
}
async function runCommand(file, options) {
  const interactive = startUi("smartlinks run", options.json === true);
  const originalSource = await readFile(file, "utf8");
  const source = options.minify ? await minifyScriptBody(originalSource) : wrapScriptBody(originalSource);
  const method = options.method.toUpperCase();
  const guestFetch = options.allowNetwork ? createGuardedFetch({ fetchImpl: createNodeFetch() }) : async () => {
    throw new Error(
      "Network access is disabled. Re-run with --allow-network to enable ctx.fetch."
    );
  };
  const result = await runScript({
    version: "2",
    source,
    context: {
      params: userParams(Object.entries(assignments(options.param, "Parameter"))),
      method,
      headers: lowercaseHeaders(
        options.header.map((value) => splitAssignment(value, "Header")),
        true
      ),
      body: localRequestBody(method, options.body),
      secrets: await resolveSecrets(options.secret, { prompt: interactive })
    },
    fetch: guestFetch
  });
  const response = mapScriptResult(result);
  const output = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text()
  };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (interactive) {
    p3.note(output.body || "(empty)", `Response \xB7 HTTP ${output.status}`);
    if (Object.keys(output.headers).length) {
      p3.log.info(JSON.stringify(output.headers));
    }
    p3.outro("Executed locally in a fresh QuickJS sandbox");
  } else {
    console.log(output.body);
    console.error(`HTTP ${output.status}`);
  }
}
async function storeWorkerSecret(name, value, json) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const subprocess = spawn(executable, ["wrangler", "secret", "put", name], {
    stdio: ["pipe", json ? "pipe" : "inherit", "inherit"]
  });
  subprocess.stdout?.pipe(process.stderr);
  if (!subprocess.stdin) {
    throw new Error("Could not open Wrangler's standard input.");
  }
  subprocess.stdin.end(value);
  const exitCode = await new Promise((resolve, reject) => {
    subprocess.once("error", reject);
    subprocess.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`Wrangler exited with code ${exitCode ?? "unknown"}.`);
  }
}
async function keygenCommand(options) {
  const generated = await generateKeyPair(Number(options.keyId));
  const name = `PRIVATE_KEY_${generated.keyId}`;
  if (options.setWorker) {
    await storeWorkerSecret(name, generated.privateKeySecret, options.json === true);
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        options.setWorker ? { keyId: generated.keyId, publicKey: generated.publicKey, workerSecret: name } : generated,
        null,
        2
      )
    );
    return;
  }
  const interactive = startUi("smartlinks keygen", false);
  if (interactive) {
    if (options.setWorker) {
      p3.log.success(`Stored ${name} with Wrangler`);
    } else {
      p3.note(generated.privateKeySecret, `${name} value \xB7 shown once`);
      p3.log.info(`Store it securely with: npx wrangler secret put ${name}`);
    }
    p3.log.info(`Public key: ${generated.publicKey}`);
    p3.outro("Keep older private-key secrets deployed so existing links continue to work");
  } else if (options.setWorker) {
    console.log(`Stored ${name}.`);
    console.error(`Public key: ${generated.publicKey}`);
  } else {
    console.log(generated.privateKeySecret);
    console.error(`Secret name: ${name}`);
    console.error(`Public key: ${generated.publicKey}`);
  }
}
var program = new Command().name("smartlinks").description("Turn small JavaScript programs into self-contained, executable URLs.").version("0.1.0").showHelpAfterError().addHelpText(
  "after",
  `
Examples:
  smartlinks build script.js --interstitial
  smartlinks build script.js --secret GITHUB_TOKEN --copy
  smartlinks decode 'https://service.example/r/2\u2026'
  smartlinks run script.js --param owner=jonaslsaa
`
);
program.command("build").description("Minify a script and build an executable smartlink.").argument("<script.js>", "JavaScript function body to encode").option("-i, --interstitial", "require browser confirmation before execution").option("-s, --secret <NAME[=value]>", "seal a secret; repeatable", collect, []).option("--service <url>", "runtime base URL").option("--copy", "copy the finished link to the clipboard").option("--json", "print machine-readable output").addOption(new Option("--no-minify", "preserve source formatting instead of minifying")).action(buildCommand);
program.command("decode").description("Inspect a smartlink without executing it.").argument("<link-or-payload>", "smartlink URL or encoded payload").option("--json", "print machine-readable output").action(decodeCommand);
program.command("run").description("Execute a script locally in the production QuickJS sandbox.").argument("<script.js>", "JavaScript function body to execute").option("-p, --param <NAME=value>", "query parameter; repeatable", collect, []).option("-s, --secret <NAME[=value]>", "secret from value, environment, or prompt", collect, []).option("-H, --header <NAME=value>", "request header; repeatable", collect, []).option("-X, --method <method>", "request method", "GET").option("--body <text>", "request body").option("--allow-network", "allow guarded outbound ctx.fetch calls").option("--json", "print machine-readable output").addOption(new Option("--no-minify", "preserve source formatting instead of minifying")).action(runCommand);
program.command("keygen").description("Generate an X25519 HPKE key pair for the Worker.").option("--key-id <number>", "one-byte rotation key ID", "1").option("--set-worker", "store the private key using Wrangler instead of printing it").option("--json", "print machine-readable output").action(keygenCommand);
program.parseAsync().catch((error) => {
  fail(error);
  process.exitCode = 1;
});
//# sourceMappingURL=index.js.map