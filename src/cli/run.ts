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
  try {
    const originalSource = await readScriptSource(options.file, { typeCheck: options.typeCheck });
    const { source, closures } = await prepareSmartlinkProgram(originalSource, options.minify);
    const url = new URL(request.url);
    const result: ScriptResult = await runLocalProgram({
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

    return {
      binary: isBinaryLiteralResponse(result),
      defaultPage: result === undefined,
      response: mapScriptResult(result),
    };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }
    throw new LocalScriptError(errorMessage(error), { cause: error });
  }
}
