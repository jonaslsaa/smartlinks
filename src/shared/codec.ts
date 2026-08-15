import { deflateSync, Inflate } from "fflate";
import { z } from "zod";
import { fromBase64Url, text, toBase64Url, utf8 } from "./bytes.js";

export const CURRENT_PAYLOAD_VERSION = "2" as const;
export const MAX_PAYLOAD_LENGTH = 7_800;
export const MAX_SCRIPT_LENGTH = 1_000_000;
// A single JavaScript code unit can occupy six UTF-8 bytes after JSON escaping
// (for example, a lone surrogate). Keep extra room for envelope metadata and secrets.
export const MAX_DECOMPRESSED_LENGTH = MAX_SCRIPT_LENGTH * 6 + 64_000;
export const MAX_NOT_AFTER = 8_640_000_000_000;
export const MAX_COMPILE_CLOSURES = 64;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

const sealedSecretSchema = z.record(
  z.string().regex(SECRET_NAME, "Secret names must look like environment variables."),
  z.string().min(1).max(2_048),
);

export const envelopeSchema = z
  .object({
    s: z.string().min(1).max(MAX_SCRIPT_LENGTH),
    i: z.literal(true).optional(),
    a: z.literal(1).optional(),
    c: z.array(z.string().min(1).max(MAX_SCRIPT_LENGTH)).max(MAX_COMPILE_CLOSURES).optional(),
    k: sealedSecretSchema.optional(),
    notAfter: z.number().int().positive().max(MAX_NOT_AFTER).optional(),
  })
  .strict();

export type Envelope = z.infer<typeof envelopeSchema>;
export type PayloadVersion = "1" | "2";

export type DecodedPayload = {
  version: PayloadVersion;
  envelope: Envelope;
};

export type RawDeflate = (input: Uint8Array) => Uint8Array;
export type RawDeflates = readonly [RawDeflate, ...RawDeflate[]];

export function serializeEnvelope(input: Envelope): Uint8Array {
  const envelope = envelopeSchema.parse(input);
  const serialized = utf8(JSON.stringify(envelope));
  if (serialized.byteLength > MAX_DECOMPRESSED_LENGTH) {
    throw new Error("The serialized payload is too large.");
  }
  return serialized;
}

export function payloadFromCompressed(
  compressed: Uint8Array,
  version: PayloadVersion = CURRENT_PAYLOAD_VERSION,
): string {
  const payload = `${version}${toBase64Url(compressed)}`;
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(
      `The encoded payload is ${payload.length.toLocaleString()} characters; the limit is ${MAX_PAYLOAD_LENGTH.toLocaleString()}.`,
    );
  }
  return payload;
}

export function isExpired(
  notAfter: number | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  return notAfter !== undefined && notAfter <= nowSeconds;
}

export function formatNotAfter(notAfter: number): string {
  return new Date(notAfter * 1_000).toISOString();
}

function inflateWithLimit(compressed: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const inflate = new Inflate((chunk) => {
    length += chunk.byteLength;
    if (length > MAX_DECOMPRESSED_LENGTH) {
      throw new Error("The decoded payload is too large.");
    }
    chunks.push(chunk);
  });

  for (let offset = 0; offset < compressed.byteLength; offset += 256) {
    const end = Math.min(offset + 256, compressed.byteLength);
    inflate.push(compressed.subarray(offset, end), end === compressed.byteLength);
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function encodePayloadWith(
  input: Envelope,
  deflates: RawDeflates,
  version: PayloadVersion = CURRENT_PAYLOAD_VERSION,
): string {
  const serialized = serializeEnvelope(input);
  const payload = deflates
    .map((deflate) => `${version}${toBase64Url(deflate(serialized))}`)
    .reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest));

  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(
      `The encoded payload is ${payload.length.toLocaleString()} characters; the limit is ${MAX_PAYLOAD_LENGTH.toLocaleString()}.`,
    );
  }

  return payload;
}

export function encodePayload(
  input: Envelope,
  version: PayloadVersion = CURRENT_PAYLOAD_VERSION,
): string {
  return encodePayloadWith(input, [(serialized) => deflateSync(serialized, { level: 9 })], version);
}

export function readPayloadVersion(payload: string): PayloadVersion {
  if (payload.length < 2 || payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error("The payload length is invalid.");
  }

  const version = payload[0];
  if (version !== "1" && version !== "2") {
    throw new Error(`Unsupported payload version: ${version ?? "missing"}.`);
  }
  return version;
}

export function readCompressedPayload(payload: string): Uint8Array {
  return fromBase64Url(payload.slice(1));
}

export function parseDecompressedPayload(
  version: PayloadVersion,
  decompressed: Uint8Array,
): DecodedPayload {
  return {
    version,
    envelope: envelopeSchema.parse(JSON.parse(text(decompressed))),
  };
}

export function invalidPayload(error: unknown): Error {
  return new Error("The smartlink payload is invalid or corrupted.", { cause: error });
}

export function decodePayload(payload: string): DecodedPayload {
  const version = readPayloadVersion(payload);

  try {
    return parseDecompressedPayload(version, inflateWithLimit(readCompressedPayload(payload)));
  } catch (error) {
    throw invalidPayload(error);
  }
}

export function payloadFromInput(input: string): string {
  const trimmed = input.trim();
  if (/^[12][A-Za-z0-9_-]+$/u.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/r\/([^/]+)$/u) ?? url.pathname.match(/\/d\/([^/]+)$/u);
    if (!match?.[1]) {
      throw new Error("missing payload path");
    }
    return match[1];
  } catch (error) {
    throw new Error("Expected a smartlink URL or encoded payload.", { cause: error });
  }
}
