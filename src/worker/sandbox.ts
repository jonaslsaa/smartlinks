import quickJsVariant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import quickJsWasm from "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import type { PayloadVersion } from "../shared/codec.js";
import type { GuestFetch } from "../shared/guarded-fetch.js";
import type { CryptoOperationBudget, GuestCrypto } from "../shared/guest-crypto.js";
import type { GuestCompile } from "../shared/mint.js";
import {
  runScriptWithModule,
  type SandboxContext,
  validateScriptWithModule,
} from "../shared/sandbox.js";

const quickJsModule = newQuickJSWASMModuleFromVariant(
  newVariant(quickJsVariant, { wasmModule: quickJsWasm }),
);

type RunWorkerScriptOptions = {
  version: PayloadVersion;
  source: string;
  context: SandboxContext;
  fetch: GuestFetch;
  crypto?: GuestCrypto;
  cryptoBudget?: CryptoOperationBudget;
  compile?: GuestCompile;
};

export function runWorkerScript(options: RunWorkerScriptOptions) {
  return runScriptWithModule(options, quickJsModule);
}

export function validateWorkerScript(version: PayloadVersion, source: string) {
  return validateScriptWithModule(version, source, quickJsModule);
}
