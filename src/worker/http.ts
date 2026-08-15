import { RequestBodyTooLargeError, readBoundedRequestBody } from "../shared/request-context.js";

type HttpErrorOptions = ErrorOptions & {
  headers?: HeadersInit;
};

export class HttpError extends Error {
  readonly headers: Headers;
  readonly status: number;

  constructor(status: number, message: string, options?: HttpErrorOptions) {
    super(message, options);
    this.name = "HttpError";
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

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(body, { ...init, headers });
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(value, { ...init, headers });
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
