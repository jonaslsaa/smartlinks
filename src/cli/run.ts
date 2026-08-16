import {
  createRequestId,
  guestRequestHeaders,
  localRequestBody,
  lowercaseHeaders,
  RequestBodyTooLargeError,
  readBoundedRequestBody,
  userParams,
  userParamValues,
} from "../shared/request-context.js";
import { isBinaryLiteralResponse, mapScriptResult, type ScriptResult } from "../shared/result.js";
import { prepareSmartlinkProgram } from "./build.js";
import { type LocalRuntime, runLocalProgram } from "./local-run.js";
import { LocalSimulation, type SimulationReport } from "./simulation.js";
import { readScriptSource } from "./source.js";

type LocalScriptOptions = {
  allowNetwork: boolean;
  blockedHostnames: readonly string[];
  file: string;
  minify: boolean;
  secrets: Record<string, string>;
  simulate?: boolean;
  simulationResponses?: readonly number[];
  typeCheck: boolean;
};

type SyntheticRequestOptions = {
  body?: string;
  headers: Iterable<readonly [string, string]>;
  method: string;
  parameters: Iterable<readonly [string, string]>;
};

export type LocalScriptExecution = {
  binary: boolean;
  defaultPage: boolean;
  response: Response;
  simulation?: SimulationReport;
};

type LocalRequestContext = {
  params: Record<string, string>;
  paramValues: Record<string, string[]>;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  requestId: string;
};

export class LocalScriptError extends Error {
  readonly status = 422;
  readonly simulation?: SimulationReport;

  constructor(message: string, options?: ErrorOptions & { simulation?: SimulationReport }) {
    super(message, options);
    this.name = "LocalScriptError";
    if (options?.simulation) {
      this.simulation = options.simulation;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown local execution error.";
}

export function createSyntheticRequest(options: SyntheticRequestOptions): Request {
  const url = new URL("http://smartlinks.local/");
  for (const [name, value] of options.parameters) {
    url.searchParams.append(name, value);
  }

  const method = options.method.toUpperCase();
  const body = localRequestBody(method, options.body);
  const init: RequestInit = {
    method,
    headers: lowercaseHeaders(options.headers, true),
  };
  if (body !== null) {
    // A byte body avoids Request adding a synthetic content-type header that one-shot run did
    // not receive before it was expressed through the Web Request API.
    init.body = new TextEncoder().encode(body);
  }
  return new Request(url, init);
}

async function localRequestContext(request: Request): Promise<LocalRequestContext> {
  const url = new URL(request.url);
  return {
    params: userParams(url.searchParams),
    paramValues: userParamValues(url.searchParams),
    method: request.method,
    headers: guestRequestHeaders(request.headers),
    body: await readBoundedRequestBody(request),
    requestId: createRequestId(),
  };
}

function mappedExecution(result: ScriptResult): LocalScriptExecution {
  return {
    binary: isBinaryLiteralResponse(result),
    defaultPage: result === undefined,
    response: mapScriptResult(result),
  };
}

export async function executeLocalRequest(
  request: Request,
  options: LocalScriptOptions,
  runtime?: LocalRuntime,
): Promise<LocalScriptExecution> {
  let simulation: LocalSimulation | undefined;
  try {
    const originalSource = await readScriptSource(options.file, {
      secretNames: Object.keys(options.secrets),
      typeCheck: options.typeCheck,
    });
    const { source, closures } = await prepareSmartlinkProgram(originalSource, options.minify);
    const context = await localRequestContext(request);
    if (options.simulate) {
      simulation = new LocalSimulation(
        {
          method: context.method,
          params: context.paramValues,
          headers: context.headers,
          body: context.body,
        },
        options.secrets,
        options.simulationResponses,
      );
    }
    const program = {
      source,
      closures,
      context: {
        ...context,
        secrets: options.secrets,
      },
      ...(simulation ? { simulation } : {}),
    };
    const result: ScriptResult = runtime
      ? await runtime.executeProgram(program)
      : await runLocalProgram({
          ...program,
          allowNetwork: options.allowNetwork,
          blockedHostnames: options.blockedHostnames,
        });

    const execution = mappedExecution(result);

    return {
      ...execution,
      ...(simulation
        ? {
            simulation: await simulation.success(execution.response.clone(), execution.binary),
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }
    throw new LocalScriptError(errorMessage(error), {
      cause: error,
      ...(simulation ? { simulation: await simulation.failure(error) } : {}),
    });
  }
}

export async function executeLocalPayloadRequest(
  request: Request,
  payload: string,
  runtime: LocalRuntime,
): Promise<LocalScriptExecution> {
  try {
    return mappedExecution(
      await runtime.executePayload(payload, await localRequestContext(request)),
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }
    throw new LocalScriptError(errorMessage(error), { cause: error });
  }
}
