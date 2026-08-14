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
import { parseScriptResult, type ScriptResult } from "./result.js";
import { executableSource } from "./script.js";

const MAX_MEMORY_BYTES = 16 * 1_024 * 1_024;
const MAX_STACK_BYTES = 512 * 1_024;
const MAX_INTERRUPT_TICKS = 1_500;
const MAX_EXECUTION_MS = 15_000;

const sandboxContextSchema = z.object({
  params: z.record(z.string(), z.string()),
  method: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  secrets: z.record(z.string(), z.string()),
});

export type SandboxContext = z.infer<typeof sandboxContextSchema>;

type RunScriptOptions = {
  version: PayloadVersion;
  source: string;
  context: SandboxContext;
  fetch: GuestFetch;
  timeoutMs?: number;
};

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

  try {
    const initialContext = sandboxContextSchema.parse(options.context);
    const contextHandle = jsonHandle(vm, initialContext);
    const fetchHandle = vm.newFunction("fetch", (urlHandle, optionsHandle) => {
      const url = vm.getString(urlHandle);
      const rawOptions: unknown = optionsHandle ? vm.dump(optionsHandle) : undefined;
      const deferred = vm.newPromise();
      pendingDeferreds.add(deferred);

      const rejectDeferred = (error: unknown) => {
        if (!deferred.alive) {
          return;
        }
        const message = error instanceof Error ? error.message : "Fetch failed.";
        const errorHandle = vm.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      };

      let hostCall: Promise<void>;
      hostCall = options
        .fetch(url, rawOptions)
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

    vm.setProp(contextHandle, "fetch", fetchHandle);
    vm.setProp(vm.global, "__smartlinks_ctx", contextHandle);
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
