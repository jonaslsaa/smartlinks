import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { z } from "zod";
import type { PayloadVersion } from "./codec.js";
import type { GuestFetch } from "./guarded-fetch.js";
import {
  type CryptoOperationBudget,
  createCryptoOperationBudget,
  createGuestCrypto,
  type GuestCrypto,
  type GuestTokenOptions,
} from "./guest-crypto.js";
import {
  type GuestCompile,
  MAX_COMPILE_ARGUMENT_DEPTH,
  MAX_COMPILE_ARGUMENT_VALUES,
} from "./mint.js";
import { parseScriptResult, type ScriptResult } from "./result.js";
import { executableSource } from "./script.js";

const MAX_MEMORY_BYTES = 16 * 1_024 * 1_024;
const MAX_STACK_BYTES = 512 * 1_024;
const MAX_INTERRUPT_TICKS = 1_500;
const MAX_EXECUTION_MS = 15_000;

const sandboxContextSchema = z.object({
  params: z.record(z.string(), z.string()),
  paramValues: z.record(z.string(), z.array(z.string())),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  secrets: z.record(z.string(), z.string()),
  requestId: z.string().min(1),
});

export type SandboxContext = z.infer<typeof sandboxContextSchema>;

type RunScriptOptions = {
  version: PayloadVersion;
  source: string;
  context: SandboxContext;
  fetch: GuestFetch;
  crypto?: GuestCrypto;
  cryptoBudget?: CryptoOperationBudget;
  compile?: GuestCompile;
  timeoutMs?: number;
};

const webApiBootstrap = `
(() => {
  const hostFetch = globalThis.__smartlinks_host_fetch;
  const beginCompile = globalThis.__smartlinks_begin_compile;
  const hostCompile = globalThis.__smartlinks_host_compile;
  const CompileError = Error;
  const arrayIsArray = Array.isArray;
  const arrayPush = Array.prototype.push;
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  const jsonStringify = JSON.stringify;
  const numberFromString = Number;
  const numberIsFinite = Number.isFinite;
  const numberIsInteger = Number.isInteger;
  const objectCreate = Object.create;
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const objectGetPrototypeOf = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const objectSetPrototypeOf = Object.setPrototypeOf;
  const ownKeys = Reflect.ownKeys;
  const reflectApply = Reflect.apply;
  const arrayIndexPattern = /^(?:0|[1-9][0-9]*)$/;
  const regexpTest = RegExp.prototype.test;
  delete globalThis.__smartlinks_host_fetch;
  delete globalThis.__smartlinks_begin_compile;
  delete globalThis.__smartlinks_host_compile;

  function serializeCompileValue(value, depth, state) {
    state.values += 1;
    if (state.values > ${MAX_COMPILE_ARGUMENT_VALUES}) {
      throw new CompileError("Compile arguments may contain at most ${MAX_COMPILE_ARGUMENT_VALUES} values.");
    }
    if (depth > ${MAX_COMPILE_ARGUMENT_DEPTH}) {
      throw new CompileError("Compile arguments may be nested at most ${MAX_COMPILE_ARGUMENT_DEPTH} levels.");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!numberIsFinite(value)) {
        throw new CompileError("Compile arguments may contain only finite numbers.");
      }
      return value;
    }
    if (arrayIsArray(value)) {
      const normalized = objectSetPrototypeOf([], null);
      for (let index = 0; index < value.length; index += 1) {
        if (!reflectApply(hasOwnProperty, value, [index])) {
          throw new CompileError("Compile arguments may not contain sparse arrays.");
        }
        reflectApply(arrayPush, normalized, [
          serializeCompileValue(value[index], depth + 1, state),
        ]);
      }
      const keys = ownKeys(value);
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        const key = keys[keyIndex];
        if (
          key !== "length" &&
          (typeof key !== "string" ||
            !reflectApply(regexpTest, arrayIndexPattern, [key]) ||
            numberFromString(key) >= value.length)
        ) {
          throw new CompileError("Compile argument arrays may not contain extra properties.");
        }
      }
      return normalized;
    }
    if (typeof value === "object") {
      const prototype = objectGetPrototypeOf(value);
      if (prototype !== objectPrototype && prototype !== null) {
        throw new CompileError("Compile arguments must contain only plain JSON objects.");
      }
      const normalized = objectCreate(null);
      const keys = ownKeys(value);
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        const key = keys[keyIndex];
        if (typeof key !== "string") {
          throw new CompileError("Compile arguments may not contain symbol keys.");
        }
        if (key === "__proto__") {
          throw new CompileError('Compile arguments may not contain a "__proto__" key.');
        }
        if (!objectGetOwnPropertyDescriptor(value, key)?.enumerable) {
          throw new CompileError("Compile arguments may not contain non-enumerable properties.");
        }
        normalized[key] = serializeCompileValue(value[key], depth + 1, state);
      }
      return normalized;
    }
    throw new CompileError("Compile arguments must be JSON-serializable values.");
  }

  function serializeCompileInput(args, options) {
    if (!arrayIsArray(args)) {
      throw new CompileError("ctx.compile requires an argument tuple as its second argument.");
    }
    const normalizedArgs = serializeCompileValue(args, 0, { values: 0 });
    const normalizedOptions =
      options === undefined
        ? undefined
        : serializeCompileValue(options, 0, { values: 0 });
    const serialized = objectCreate(null);
    serialized.args = jsonStringify(normalizedArgs);
    serialized.options =
      normalizedOptions === undefined ? undefined : jsonStringify(normalizedOptions);
    return serialized;
  }

  class SmartlinksHeaders {
    constructor(values) {
      this._entries = Object.freeze({ ...values });
    }
    get(name) {
      return this._entries[String(name).toLowerCase()] ?? null;
    }
    has(name) {
      return Object.prototype.hasOwnProperty.call(this._entries, String(name).toLowerCase());
    }
    *entries() {
      yield* Object.entries(this._entries);
    }
    *keys() {
      yield* Object.keys(this._entries);
    }
    *values() {
      yield* Object.values(this._entries);
    }
    forEach(callback, thisArg) {
      for (const [name, value] of this.entries()) {
        callback.call(thisArg, value, name, this);
      }
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }

  class SmartlinksResponse {
    constructor(result) {
      this.status = result.status;
      this.statusText = result.statusText;
      this.ok = result.status >= 200 && result.status < 300;
      this.url = result.url;
      this.redirected = result.redirected;
      this.headers = new SmartlinksHeaders(result.headers);
      this._bodyUsed = false;
      this._body = result.text;
    }
    get bodyUsed() {
      return this._bodyUsed;
    }
    consume() {
      if (this._bodyUsed) {
        throw new TypeError("Body has already been consumed.");
      }
      this._bodyUsed = true;
      return this._body;
    }
    async text() {
      return this.consume();
    }
    async json() {
      return JSON.parse(this.consume());
    }
  }

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input, init) => new SmartlinksResponse(await hostFetch(input, init)),
  });

  {
    const cryptoApi = globalThis.__smartlinks_ctx.crypto;
    const hostSeal = cryptoApi.seal;
    const hostOpen = cryptoApi.open;
    const checkTokenOptions = (options) => {
      if (
        options !== null &&
        typeof options === "object" &&
        reflectApply(hasOwnProperty, options, ["key"]) &&
        options.key === undefined
      ) {
        throw new CompileError(
          'The token key is undefined. Pass a string of at least 16 bytes or omit "key".',
        );
      }
      return options;
    };
    cryptoApi.seal = (value, options) =>
      hostSeal(jsonStringify(value), checkTokenOptions(options));
    cryptoApi.open = (token, options) => hostOpen(token, checkTokenOptions(options));
  }

  if (hostCompile && beginCompile) {
    Object.defineProperty(globalThis.__smartlinks_ctx, "compile", {
      configurable: true,
      writable: true,
      value: async (closureIndex, args, options) => {
        await beginCompile();
        if (!numberIsInteger(closureIndex) || closureIndex < 0) {
          throw new CompileError("ctx.compile requires a packaged closure as its first argument.");
        }
        const serialized = serializeCompileInput(args, options);
        return hostCompile(closureIndex, serialized.args, serialized.options);
      },
    });
  }
})();
`;

let defaultQuickJsModule: Promise<QuickJSWASMModule> | undefined;

function getDefaultQuickJsModule(): Promise<QuickJSWASMModule> {
  defaultQuickJsModule ??= newQuickJSWASMModuleFromVariant(
    import("@jitl/quickjs-wasmfile-release-sync"),
  );
  return defaultQuickJsModule;
}

function errorMessage(vm: QuickJSContext, handle: QuickJSHandle): string {
  const value: unknown = vm.dump(handle);
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

function jsonHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return vm.undefined;
  }
  return vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(serialized)})`));
}

export async function runScript(options: RunScriptOptions): Promise<ScriptResult> {
  return runScriptWithModule(options, getDefaultQuickJsModule());
}

export async function validateScript(version: PayloadVersion, source: string): Promise<void> {
  return validateScriptWithModule(version, source, getDefaultQuickJsModule());
}

export async function validateScriptWithModule(
  version: PayloadVersion,
  source: string,
  quickJsModule: Promise<QuickJSWASMModule>,
): Promise<void> {
  const module = await quickJsModule;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const vm = runtime.newContext();

  try {
    const compiled = vm.evalCode(executableSource(version, source), "smartlink.js", {
      compileOnly: true,
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

export async function runScriptWithModule(
  options: RunScriptOptions,
  quickJsModule: Promise<QuickJSWASMModule>,
): Promise<ScriptResult> {
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
  const pendingDeferreds = new Set<QuickJSDeferredPromise>();
  const pendingHostCalls = new Set<Promise<void>>();
  let promiseHandle: QuickJSHandle | undefined;
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  let compileAttempted = false;
  const timedOut = new Promise<never>((_resolve, reject) => {
    executionTimer = setTimeout(
      () => reject(new Error(`Script execution exceeded ${timeoutMs.toLocaleString()} ms.`)),
      timeoutMs,
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

  const asyncHostFunction = (
    name: string,
    operation: (...args: unknown[]) => Promise<unknown>,
    beforeArguments?: () => void,
  ): QuickJSHandle =>
    vm.newFunction(name, (...argumentHandles) => {
      const deferred = vm.newPromise();
      pendingDeferreds.add(deferred);

      const rejectDeferred = (error: unknown) => {
        if (!deferred.alive) {
          return;
        }
        const message = error instanceof Error ? error.message : `${name} failed.`;
        const errorHandle = vm.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      };

      try {
        beforeArguments?.();
      } catch (error) {
        rejectDeferred(error);
        pendingDeferreds.delete(deferred);
        return deferred.handle;
      }

      const args = argumentHandles.map((handle) => vm.dump(handle));

      let hostCall: Promise<void>;
      hostCall = operation(...args)
        .then((result) => {
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
        }, rejectDeferred)
        .finally(() => {
          pendingDeferreds.delete(deferred);
          pendingHostCalls.delete(hostCall);
        });
      pendingHostCalls.add(hostCall);

      return deferred.handle;
    });

  try {
    const initialContext = sandboxContextSchema.parse(options.context);
    const contextHandle = jsonHandle(vm, initialContext);
    const fetchHandle = asyncHostFunction("fetch", async (url, rawOptions) => {
      if (typeof url !== "string") {
        throw new TypeError("fetch requires a URL string.");
      }
      return options.fetch(url, rawOptions);
    });
    vm.setProp(vm.global, "__smartlinks_host_fetch", fetchHandle);

    const cryptoBudget = options.cryptoBudget ?? createCryptoOperationBudget();
    const guestCrypto = options.crypto ?? createGuestCrypto(crypto, cryptoBudget);
    const cryptoHandle = vm.newObject();
    const sha256Handle = asyncHostFunction("sha256", async (message, encoding) => {
      if (typeof message !== "string") {
        throw new TypeError("sha256 requires a string message.");
      }
      return guestCrypto.sha256(message, encoding as "hex" | "base64" | undefined);
    });
    const hmacHandle = asyncHostFunction("hmacSha256", async (key, message, encoding) => {
      if (typeof key !== "string" || typeof message !== "string") {
        throw new TypeError("hmacSha256 requires string key and message values.");
      }
      return guestCrypto.hmacSha256(key, message, encoding as "hex" | "base64" | undefined);
    });
    const verifyHandle = asyncHostFunction(
      "verifyHmacSha256",
      async (key, message, signature, encoding) => {
        if (
          typeof key !== "string" ||
          typeof message !== "string" ||
          typeof signature !== "string"
        ) {
          throw new TypeError(
            "verifyHmacSha256 requires string key, message, and signature values.",
          );
        }
        return guestCrypto.verifyHmacSha256(
          key,
          message,
          signature,
          encoding as "hex" | "base64" | undefined,
        );
      },
    );
    const sealHandle = asyncHostFunction("seal", async (serialized, options) => {
      if (serialized !== undefined && typeof serialized !== "string") {
        throw new TypeError("seal requires a JSON-serializable value.");
      }
      return guestCrypto.seal(
        serialized === undefined ? undefined : JSON.parse(serialized),
        options as GuestTokenOptions,
      );
    });
    const openHandle = asyncHostFunction("open", async (token, options) => {
      if (typeof token !== "string") {
        throw new TypeError("open requires a token string.");
      }
      return guestCrypto.open(token, options as GuestTokenOptions);
    });
    vm.setProp(cryptoHandle, "sha256", sha256Handle);
    vm.setProp(cryptoHandle, "hmacSha256", hmacHandle);
    vm.setProp(cryptoHandle, "verifyHmacSha256", verifyHandle);
    vm.setProp(cryptoHandle, "seal", sealHandle);
    vm.setProp(cryptoHandle, "open", openHandle);
    vm.setProp(contextHandle, "crypto", cryptoHandle);
    let beginCompileHandle: QuickJSHandle | undefined;
    let compileHandle: QuickJSHandle | undefined;
    if (options.compile) {
      beginCompileHandle = asyncHostFunction(
        "beginCompile",
        async () => undefined,
        () => {
          if (compileAttempted) {
            throw new Error("A smartlink may call ctx.compile at most once per execution.");
          }
          compileAttempted = true;
        },
      );
      compileHandle = asyncHostFunction(
        "compile",
        async (closureIndex, serializedArgs, serializedOptions) => {
          if (typeof serializedArgs !== "string") {
            throw new Error("Could not read the compile argument tuple.");
          }
          if (serializedOptions !== undefined && typeof serializedOptions !== "string") {
            throw new Error("Could not read the compile options.");
          }
          return options.compile?.(
            closureIndex,
            JSON.parse(serializedArgs),
            serializedOptions === undefined ? undefined : JSON.parse(serializedOptions),
          );
        },
      );
      vm.setProp(vm.global, "__smartlinks_begin_compile", beginCompileHandle);
      vm.setProp(vm.global, "__smartlinks_host_compile", compileHandle);
    }
    vm.setProp(vm.global, "__smartlinks_ctx", contextHandle);
    const bootstrap = vm.evalCode(webApiBootstrap, "smartlinks-web-api.js");
    if (bootstrap.error) {
      const message = errorMessage(vm, bootstrap.error);
      bootstrap.error.dispose();
      throw new Error(`Could not initialize the Smartlinks Web API: ${message}`);
    }
    bootstrap.value.dispose();
    openHandle.dispose();
    sealHandle.dispose();
    verifyHandle.dispose();
    hmacHandle.dispose();
    sha256Handle.dispose();
    cryptoHandle.dispose();
    compileHandle?.dispose();
    beginCompileHandle?.dispose();
    fetchHandle.dispose();
    contextHandle.dispose();

    const evaluated = vm.evalCode(
      executableSource(options.version, options.source),
      "smartlink.js",
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
        const dumped: unknown = vm.dump(state.value);
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
    if (executionTimer !== undefined) {
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
