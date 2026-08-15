import ipaddr from "ipaddr.js";
import { z } from "zod";

export const MAX_FETCHES = 5;
export const MAX_FETCH_RESPONSE_BYTES = 1_048_576;
const MAX_FETCH_REQUEST_BYTES = 1_048_576;
const MAX_HEADER_BYTES = 16_384;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const encoder = new TextEncoder();

const fetchOptionsSchema = z
  .object({
    method: z
      .string()
      .regex(/^[A-Za-z]+$/u)
      .max(16)
      .optional(),
    headers: z.record(z.string().max(256), z.string().max(8_192)).optional(),
    body: z.string().optional(),
  })
  .strict();

export type GuestFetchResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
  url: string;
  redirected: boolean;
};

export type GuestFetch = (url: string, options?: unknown) => Promise<GuestFetchResponse>;

export type FetchImplementation = (input: URL, init: RequestInit) => Promise<Response>;

type GuardedFetchOptions = {
  fetchImpl?: FetchImplementation;
  maxFetches?: number;
  timeoutMs?: number;
  blockedHostnames?: readonly string[];
};

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}

export function assertPublicIpAddress(address: string): void {
  if (!ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast") {
    throw new Error("Fetches to private, local, or reserved IP addresses are blocked.");
  }
}

export function assertPublicUrl(input: string): URL {
  if (input.length > 4_096) {
    throw new Error("Fetch URL is too long.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error("fetch requires an absolute URL.", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("fetch only supports http: and https: URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials are not allowed in fetch URLs.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("Fetches to local hostnames are blocked.");
  }

  if (ipaddr.isValid(hostname)) {
    assertPublicIpAddress(hostname);
  }

  return url;
}

function assertAllowedUrl(input: string, blockedHostnames: ReadonlySet<string>): URL {
  const url = assertPublicUrl(input);
  if (blockedHostnames.has(normalizeHostname(url.hostname))) {
    throw new Error("Fetches to the Smartlinks runtime are blocked.");
  }
  return url;
}

async function readResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_FETCH_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Fetch response exceeds the 1 MB limit.");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_FETCH_RESPONSE_BYTES) {
        throw new Error("Fetch response exceeds the 1 MB limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function createGuardedFetch(options: GuardedFetchOptions = {}): GuestFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxFetches = options.maxFetches ?? MAX_FETCHES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const blockedHostnames = new Set((options.blockedHostnames ?? []).map(normalizeHostname));
  let fetchCount = 0;

  return async (input, rawOptions) => {
    const parsedOptions = fetchOptionsSchema.parse(rawOptions ?? {});
    let method = (parsedOptions.method ?? "GET").toUpperCase();
    if (method === "CONNECT" || method === "TRACE") {
      throw new Error(`${method} requests are blocked.`);
    }
    if ((method === "GET" || method === "HEAD") && parsedOptions.body !== undefined) {
      throw new Error(`${method} requests cannot include a body.`);
    }

    if (
      parsedOptions.body !== undefined &&
      encoder.encode(parsedOptions.body).byteLength > MAX_FETCH_REQUEST_BYTES
    ) {
      throw new Error("Fetch request body exceeds the 1 MB limit.");
    }

    const headers = new Headers();
    let headerBytes = 0;
    for (const [name, value] of Object.entries(parsedOptions.headers ?? {})) {
      headerBytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
      if (headerBytes > MAX_HEADER_BYTES) {
        throw new Error("Fetch headers exceed the 16 KB limit.");
      }
      const lowerName = name.toLowerCase();
      if (
        lowerName === "host" ||
        lowerName === "connection" ||
        lowerName === "content-length" ||
        lowerName === "transfer-encoding" ||
        lowerName.startsWith("cf-") ||
        lowerName.startsWith("x-forwarded-")
      ) {
        continue;
      }
      headers.set(name, value);
    }
    let url = assertAllowedUrl(input, blockedHostnames);
    let body = parsedOptions.body;
    for (let redirects = 0; ; redirects += 1) {
      fetchCount += 1;
      if (fetchCount > maxFetches) {
        throw new Error(`A script may make at most ${maxFetches} fetch requests.`);
      }

      const response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) {
          throw new Error("Fetch redirect did not include a Location header.");
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Fetch exceeded the ${MAX_REDIRECTS} redirect limit.`);
        }
        const nextUrl = assertAllowedUrl(new URL(location, url).href, blockedHostnames);
        if (nextUrl.origin !== url.origin) {
          throw new Error("Cross-origin fetch redirects are blocked.");
        }
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-encoding");
          headers.delete("content-language");
          headers.delete("content-location");
        }
        url = nextUrl;
        continue;
      }

      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of response.headers) {
        responseHeaders[name] = value;
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        text: await readResponseText(response),
        url: url.href,
        redirected: redirects > 0,
      };
    }
  };
}
