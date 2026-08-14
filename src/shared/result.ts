import { z } from "zod";

const literalResponseSchema = z
  .object({
    status: z.number().int().min(200).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  })
  .strict();

export type LiteralResponse = z.infer<typeof literalResponseSchema>;
export type ScriptResult = string | LiteralResponse | undefined;

export function parseScriptResult(input: unknown): ScriptResult {
  if (input === undefined || typeof input === "string") {
    return input;
  }
  return literalResponseSchema.parse(input);
}

export function mapScriptResult(input: unknown): Response {
  const result = parseScriptResult(input);
  if (result === undefined) {
    return new Response("<!doctype html><title>Done</title><p>✓ done</p>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
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
    return Response.redirect(url.href, 302);
  }

  const headers = new Headers(result.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const status = result.status ?? 200;
  const body = status === 204 || status === 205 || status === 304 ? null : (result.body ?? "");
  return new Response(body, { status, headers });
}
