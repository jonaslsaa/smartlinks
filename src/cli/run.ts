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
import { readScriptSource } from "./source.js";

type LocalScriptOptions = {
  allowNetwork: boolean;
  blockedHostnames: readonly string[];
  file: string;
  minify: boolean;
  secrets: Record<string, string>;
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
};

export class LocalScriptError extends Error {
  readonly status = 422;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalScriptError";
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
  let source: string;
  let closures: string[];
  try {
    const originalSource = await readScriptSource(options.file, { typeCheck: options.typeCheck });
    const prepared = await prepareSmartlinkProgram(originalSource, options.minify);
    source = prepared.source;
    closures = prepared.closures;
  } catch (error) {
    throw new LocalScriptError(errorMessage(error), { cause: error });
  }

  let result: ScriptResult;
  try {
    const url = new URL(request.url);
    result = await runLocalProgram({
      source,
      closures,
      context: {
        params: userParams(url.searchParams),
        paramValues: userParamValues(url.searchParams),
        method: request.method,
        headers: lowercaseHeaders(request.headers),
        body: await readBoundedRequestBody(request),
        secrets: options.secrets,
        requestId: createRequestId(),
      },
      allowNetwork: options.allowNetwork,
      blockedHostnames: options.blockedHostnames,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }
    throw new LocalScriptError(errorMessage(error), { cause: error });
  }

  try {
    return {
      binary: isBinaryLiteralResponse(result),
      defaultPage: result === undefined,
      response: mapScriptResult(result),
    };
  } catch (error) {
    throw new LocalScriptError(errorMessage(error), { cause: error });
  }
}
