import { z } from "zod";
import { isBodylessStatus } from "./http-status.js";
import { hardenResponse } from "./response-security.js";

export const MAX_BINARY_RESPONSE_BYTES = 1_048_576;

const literalResponseFields = {
  status: z.number().int().min(200).max(599).optional(),
  headers: z.record(z.string(), z.string()).optional(),
};

const textResponseSchema = z
  .object({
    ...literalResponseFields,
    body: z.string().optional(),
    bodyBase64: z.never().optional(),
  })
  .strict();

const binaryResponseSchema = z
  .object({
    ...literalResponseFields,
    body: z.never().optional(),
    bodyBase64: z.string(),
  })
  .strict();

const literalResponseSchema = z.union([binaryResponseSchema, textResponseSchema]);

export type BinaryLiteralResponse = z.infer<typeof binaryResponseSchema>;
export type LiteralResponse = z.infer<typeof literalResponseSchema>;
export type ScriptResult = string | LiteralResponse | undefined;

export class InvalidScriptResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidScriptResponseError";
  }
}

export function parseScriptResult(input: unknown): ScriptResult {
  if (input === undefined || typeof input === "string") {
    return input;
  }
  if (typeof input === "object" && input !== null && "body" in input && "bodyBase64" in input) {
    throw new InvalidScriptResponseError("A response cannot include both body and bodyBase64.");
  }
  try {
    return literalResponseSchema.parse(input);
  } catch (error) {
    throw new InvalidScriptResponseError(
      "The returned value does not match the Smartlinks response contract.",
      { cause: error },
    );
  }
}

export function isBinaryLiteralResponse(input: ScriptResult): input is BinaryLiteralResponse {
  return typeof input === "object" && input !== null && input.bodyBase64 !== undefined;
}

function decodeBase64Body(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new InvalidScriptResponseError("bodyBase64 must be valid Base64.");
  }

  const unpadded = value.replace(/=+$/u, "");
  const remainder = unpadded.length % 4;
  if (remainder === 1) {
    throw new InvalidScriptResponseError("bodyBase64 must be valid Base64.");
  }
  const requiredPadding = (4 - remainder) % 4;
  const providedPadding = value.length - unpadded.length;
  if (providedPadding > 0 && providedPadding !== requiredPadding) {
    throw new InvalidScriptResponseError("bodyBase64 must be valid Base64.");
  }

  const decodedLength = Math.floor((unpadded.length * 6) / 8);
  if (decodedLength > MAX_BINARY_RESPONSE_BYTES) {
    throw new InvalidScriptResponseError("bodyBase64 exceeds the 1 MB decoded body limit.");
  }

  let binary: string;
  try {
    binary = atob(`${unpadded}${"=".repeat(requiredPadding)}`);
  } catch (error) {
    throw new InvalidScriptResponseError("bodyBase64 must be valid Base64.", { cause: error });
  }
  if (binary.length !== decodedLength || btoa(binary).replace(/=+$/u, "") !== unpadded) {
    throw new InvalidScriptResponseError("bodyBase64 must be valid Base64.");
  }

  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function mapScriptResult(input: unknown): Response {
  const result = parseScriptResult(input);
  if (result === undefined) {
    return hardenResponse(
      new Response("<!doctype html><title>Done</title><p>✓ done</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }
  if (typeof result === "string") {
    let url: URL;
    try {
      url = new URL(result);
    } catch (error) {
      throw new Error("A string result must be an absolute URL.", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("A redirect result must use http: or https:.");
    }
    return hardenResponse(Response.redirect(url.href, 302));
  }

  const headers = new Headers(result.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const status = result.status ?? 200;
  const binaryBody = isBinaryLiteralResponse(result)
    ? decodeBase64Body(result.bodyBase64)
    : undefined;
  if (binaryBody && !headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }
  const body = isBodylessStatus(status)
    ? null
    : (binaryBody?.buffer ?? ("body" in result ? result.body : undefined) ?? "");
  return hardenResponse(new Response(body, { status, headers }));
}
