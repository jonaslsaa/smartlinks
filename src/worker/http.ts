import { RequestBodyTooLargeError, readBoundedRequestBody } from "../shared/request-context.js";
import { hardenResponse } from "../shared/response-security.js";

type HttpErrorOptions = ErrorOptions & {
  credentialFreeCors?: boolean;
  headers?: HeadersInit;
};

export class HttpError extends Error {
  readonly credentialFreeCors: boolean;
  readonly headers: Headers;
  readonly status: number;

  constructor(status: number, message: string, options?: HttpErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.credentialFreeCors = options?.credentialFreeCors === true;
    this.headers = new Headers(options?.headers);
    this.status = status;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return hardenResponse(new Response(body, { ...init, headers }));
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return hardenResponse(Response.json(value, { ...init, headers }));
}

export async function readBoundedBody(
  request: Request,
  limitBytes = 1_048_576,
): Promise<string | null> {
  try {
    return await readBoundedRequestBody(request, limitBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new HttpError(413, error.message, { cause: error });
    }
    throw error;
  }
}
