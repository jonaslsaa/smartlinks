import {
  createRequestId,
  localRequestBody,
  lowercaseHeaders,
  RequestBodyTooLargeError,
  readBoundedRequestBody,
  userParams,
  userParamValues,
} from "../shared/request-context.js";
import { isBinaryLiteralResponse, mapScriptResult, type ScriptResult } from "../shared/result.js";
import { prepareSmartlinkProgram } from "./build.js";
import { runLocalProgram } from "./local-run.js";
import { LocalSimulation, type SimulationReport } from "./simulation.js";
import { readScriptSource } from "./source.js";

type LocalScriptOptions = {
  allowNetwork: boolean;
  blockedHostnames: readonly string[];
  file: string;
  minify: boolean;
  secrets: Record<string, string>;
  simulate?: boolean;
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

export async function executeLocalRequest(
  request: Request,
  options: LocalScriptOptions,
): Promise<LocalScriptExecution> {
  let simulation: LocalSimulation | undefined;
  try {
    const originalSource = await readScriptSource(options.file, { typeCheck: options.typeCheck });
    const { source, closures } = await prepareSmartlinkProgram(originalSource, options.minify);
    const url = new URL(request.url);
    const params = userParams(url.searchParams);
    const paramValues = userParamValues(url.searchParams);
    const headers = lowercaseHeaders(request.headers);
    const body = await readBoundedRequestBody(request);
    if (options.simulate) {
      simulation = new LocalSimulation(
        { method: request.method, params: paramValues, headers, body },
        options.secrets,
      );
    }
    const result: ScriptResult = await runLocalProgram({
      source,
      closures,
      context: {
        params,
        paramValues,
        method: request.method,
        headers,
        body,
        secrets: options.secrets,
        requestId: createRequestId(),
      },
      allowNetwork: options.allowNetwork,
      blockedHostnames: options.blockedHostnames,
      ...(simulation ? { simulation } : {}),
    });

    const binary = isBinaryLiteralResponse(result);
    const response = mapScriptResult(result);

    return {
      binary,
      defaultPage: result === undefined,
      response,
      ...(simulation ? { simulation: await simulation.success(response.clone(), binary) } : {}),
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
