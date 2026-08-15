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

export function localRequestBody(method: string, body: string | undefined): string | null {
  if (method === "GET" || method === "HEAD") {
    if (body !== undefined) {
      throw new Error(`${method} requests cannot include a body.`);
    }
    return null;
  }
  return body ?? null;
}
