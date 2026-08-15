import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isPreviewRequest } from "../shared/bots.js";
import { MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError } from "../shared/request-context.js";
import { hardenResponse, SMARTLINKS_PREVIEW_HEADER } from "../shared/response-security.js";
import { executeLocalRequest, LocalScriptError, type LocalScriptExecution } from "./run.js";

const LOOPBACK_HOST = "127.0.0.1";

type ServeOptions = Parameters<typeof executeLocalRequest>[1] & {
  onListen(url: string): void;
  port: number;
};

class ServeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ServeRequestError";
    this.status = status;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function localPage(title: string, heading: string, detail: string, status = 200): Response {
  return hardenResponse(
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#090909;color:#f3f3f3}body{width:min(calc(100% - 32px),760px);margin:48px auto;line-height:1.55}.local{display:inline-block;padding:4px 9px;border:1px solid #3d725f;border-radius:999px;color:#8de0bf;background:#0c1d17;font-size:13px;font-weight:700}h1{font-size:28px;margin:18px 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:18px;border:1px solid #303030;background:#111;color:#eee;line-height:1.5}</style></head><body><span class="local">Local Smartlinks preview</span><h1>${escapeHtml(heading)}</h1><pre>${escapeHtml(detail)}</pre></body></html>`,
      {
        status,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
          "cross-origin-resource-policy": "same-origin",
        },
      },
    ),
  );
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function incomingBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const method = request.method?.toUpperCase() ?? "GET";
  if (method === "GET" || method === "HEAD") {
    request.resume();
    return Promise.resolve(undefined);
  }

  const declaredLength = request.headers["content-length"];
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    request.resume();
    return Promise.reject(new RequestBodyTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;

    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      length += chunk.byteLength;
      if (length > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (!settled) {
        settled = true;
        resolve(length === 0 ? undefined : Buffer.concat(chunks, length));
      }
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.once("aborted", () => {
      if (!settled) {
        settled = true;
        reject(new ServeRequestError(400, "The request body was aborted."));
      }
    });
  });
}

async function webRequest(request: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(request.url ?? "/", origin);
  if (url.origin !== origin) {
    throw new ServeRequestError(400, "Absolute request URLs must use the local server origin.");
  }

  const method = request.method?.toUpperCase() ?? "GET";
  const init: RequestInit = {
    method,
    headers: requestHeaders(request),
  };
  const body = await incomingBody(request);
  if (body !== undefined) {
    init.body = new Uint8Array(body);
  }
  return new Request(url, init);
}

function validateBrowserBoundary(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host) {
    throw new ServeRequestError(400, "The Host header does not match the local server.");
  }
  if (request.headers.origin !== undefined && request.headers.origin !== origin) {
    throw new ServeRequestError(403, "Cross-origin requests are not allowed.");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "none" && fetchSite !== "same-origin") {
    throw new ServeRequestError(403, "Cross-site requests are not allowed.");
  }
}

function errorResponse(error: unknown, accept: string | undefined): Response {
  const status =
    error instanceof ServeRequestError
      ? error.status
      : error instanceof RequestBodyTooLargeError
        ? 413
        : error instanceof LocalScriptError
          ? error.status
          : 500;
  const message =
    status < 500 && error instanceof Error ? error.message : "Internal local server error.";

  if (accept?.includes("text/html")) {
    return localPage("Smartlinks local error", "The local Smartlink did not run", message, status);
  }
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

async function writeResponse(
  method: string | undefined,
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    outgoing.setHeader(name, value);
  }
  if (method === "HEAD" || response.body === null) {
    outgoing.end();
    return;
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  origin: string,
  options: ServeOptions,
): Promise<void> {
  try {
    validateBrowserBoundary(incoming, origin);
    const request = await webRequest(incoming, origin);
    const { pathname } = new URL(request.url);
    if (pathname === "/favicon.ico") {
      await writeResponse(incoming.method, outgoing, new Response(null, { status: 204 }));
      return;
    }
    if (pathname !== "/") {
      throw new ServeRequestError(404, "Only the root path is served locally.");
    }
    if (isPreviewRequest(request)) {
      await writeResponse(
        incoming.method,
        outgoing,
        new Response(null, {
          status: 200,
          headers: { [SMARTLINKS_PREVIEW_HEADER]: "1" },
        }),
      );
      return;
    }

    const execution: LocalScriptExecution = await executeLocalRequest(request, options);
    const response = execution.defaultPage
      ? localPage("Smartlinks local preview", "Done", "The script completed without a response.")
      : execution.response;
    await writeResponse(incoming.method, outgoing, response);
  } catch (error) {
    if (outgoing.headersSent) {
      outgoing.destroy(error instanceof Error ? error : undefined);
      return;
    }
    await writeResponse(incoming.method, outgoing, errorResponse(error, incoming.headers.accept));
  }
}

export async function serveLocalScript(options: ServeOptions): Promise<void> {
  let origin = "";
  const server = createServer((request, response) => {
    void handleRequest(request, response, origin, options).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, LOOPBACK_HOST);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not determine the local server address.");
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  options.onListen(origin);

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      server.close((error) => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      server.closeIdleConnections();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.once("error", (error) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      reject(error);
    });
  });
}
