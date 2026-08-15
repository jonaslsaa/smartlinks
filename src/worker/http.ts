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
  if (request.method === "GET" || request.method === "HEAD" || !request.body) {
    return null;
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > limitBytes) {
    throw new HttpError(413, "Request body exceeds the 1 MB limit.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > limitBytes) {
        throw new HttpError(413, "Request body exceeds the 1 MB limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
