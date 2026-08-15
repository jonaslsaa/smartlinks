export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export function userParams(entries: Iterable<readonly [string, string]>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!name.startsWith("__")) {
      params[name] = value;
    }
  }
  return params;
}

export function userParamValues(
  entries: Iterable<readonly [string, string]>,
): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const [name, value] of entries) {
    if (name.startsWith("__")) {
      continue;
    }
    const values = Object.hasOwn(params, name) ? (params[name] ?? []) : [];
    values.push(value);
    params[name] = values;
  }
  return params;
}

export function createRequestId(platformId?: string | null): string {
  const normalized = platformId?.trim();
  return normalized || crypto.randomUUID();
}

export function lowercaseHeaders(
  entries: Iterable<readonly [string, string]>,
  rejectDuplicates = false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    const normalizedName = name.toLowerCase();
    if (rejectDuplicates && normalizedName in headers) {
      throw new Error(`Header ${normalizedName} was provided more than once.`);
    }
    headers[normalizedName] = value;
  }
  return headers;
}

export function guestRequestHeaders(
  entries: Iterable<readonly [string, string]>,
): Record<string, string> {
  const headers = lowercaseHeaders(entries);
  delete headers.cookie;
  return headers;
}

export function localRequestBody(method: string, body: string | undefined): string | null {
  if (method === "GET" || method === "HEAD") {
    if (body !== undefined) {
      throw new Error(`${method} requests cannot include a body.`);
    }
    return null;
  }
  return body ?? null;
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the 1 MB limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readBoundedRequestBody(
  request: Request,
  limitBytes = MAX_REQUEST_BODY_BYTES,
): Promise<string | null> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) {
    return null;
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > limitBytes) {
    throw new RequestBodyTooLargeError();
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
        throw new RequestBodyTooLargeError();
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
