import { deflateSync, Inflate } from "fflate";
import { z } from "zod";
import { authorProofSchema } from "./author.js";
import { fromBase64Url, text, toBase64Url, utf8 } from "./bytes.js";

export const CURRENT_PAYLOAD_VERSION = "2" as const;
export const MAX_PAYLOAD_LENGTH = 7_800;

export class PayloadTooLargeError extends Error {
  constructor(payloadLength: number) {
    super(
      `The encoded payload is ${payloadLength.toLocaleString()} characters; the limit is ${MAX_PAYLOAD_LENGTH.toLocaleString()}.`,
    );
    this.name = "PayloadTooLargeError";
  }
}
export const MAX_SCRIPT_LENGTH = 1_000_000;
// A single JavaScript code unit can occupy six UTF-8 bytes after JSON escaping
// (for example, a lone surrogate). Keep extra room for envelope metadata and secrets.
export const MAX_DECOMPRESSED_LENGTH = MAX_SCRIPT_LENGTH * 6 + 64_000;
export const MAX_NOT_AFTER = 8_640_000_000_000;
export const MAX_COMPILE_CLOSURES = 64;
export const MAX_INTERSTITIAL_NOTE_LENGTH = 140;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

const sealedSecretSchema = z.record(
  z.string().regex(SECRET_NAME, "Secret names must look like environment variables."),
  z.string().min(1).max(2_048),
);
const notAfterSchema = z.number().int().positive().max(MAX_NOT_AFTER);
export const interstitialNoteSchema = z.string().transform((value, context) => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    context.addIssue({ code: "custom", message: "The interstitial note cannot be empty." });
    return z.NEVER;
  }
  if ([...normalized].some(isControlCharacter)) {
    context.addIssue({
      code: "custom",
      message: "The interstitial note cannot contain control characters.",
    });
    return z.NEVER;
  }
  if ([...normalized].length > MAX_INTERSTITIAL_NOTE_LENGTH) {
    context.addIssue({
      code: "custom",
      message: `The interstitial note may contain at most ${MAX_INTERSTITIAL_NOTE_LENGTH} characters.`,
    });
    return z.NEVER;
  }
  return normalized;
});

const envelopeObjectSchema = z
  .object({
    s: z.string().min(1).max(MAX_SCRIPT_LENGTH),
    i: z.literal(true).optional(),
    a: z.union([z.literal(1), z.literal(2)]).optional(),
    c: z.array(z.string().min(1).max(MAX_SCRIPT_LENGTH)).max(MAX_COMPILE_CLOSURES).optional(),
    k: sealedSecretSchema.optional(),
    notAfter: notAfterSchema.optional(),
    interstitialNote: interstitialNoteSchema.optional(),
    u: authorProofSchema.optional(),
  })
  .strict();

export const envelopeSchema = envelopeObjectSchema.superRefine((envelope, context) => {
  if (envelope.interstitialNote !== undefined && envelope.i !== true) {
    context.addIssue({
      code: "custom",
      message: "An interstitial note requires an interstitial.",
    });
  }
  if (envelope.a === 2 && envelope.u === undefined) {
    context.addIssue({
      code: "custom",
      message: "Signed sealed secrets require an author proof.",
    });
  }
});

const wireEnvelopeSchema = envelopeObjectSchema
  .omit({ notAfter: true, interstitialNote: true })
  .extend({
    n: notAfterSchema.optional(),
    m: interstitialNoteSchema.optional(),
    // Decode links authored before expiry received its compact wire key.
    notAfter: notAfterSchema.optional(),
  })
  .superRefine((envelope, context) => {
    if (envelope.n !== undefined && envelope.notAfter !== undefined) {
      context.addIssue({
        code: "custom",
        message: 'The payload cannot contain both "n" and "notAfter".',
      });
    }
    if (envelope.m !== undefined && envelope.i !== true) {
      context.addIssue({
        code: "custom",
        message: "An interstitial note requires an interstitial.",
      });
    }
    if (envelope.a === 2 && envelope.u === undefined) {
      context.addIssue({
        code: "custom",
        message: "Signed sealed secrets require an author proof.",
      });
    }
  });

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
  const { notAfter, interstitialNote, ...wireEnvelope } = envelope;
  const serialized = utf8(
    JSON.stringify({
      ...wireEnvelope,
      ...(notAfter === undefined ? {} : { n: notAfter }),
      ...(interstitialNote === undefined ? {} : { m: interstitialNote }),
    }),
  );
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
    throw new PayloadTooLargeError(payload.length);
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
    throw new PayloadTooLargeError(payload.length);
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
  const {
    n,
    m,
    notAfter: legacyNotAfter,
    ...wireEnvelope
  } = wireEnvelopeSchema.parse(JSON.parse(text(decompressed)));
  return {
    version,
    envelope: envelopeSchema.parse({
      ...wireEnvelope,
      ...(n === undefined && legacyNotAfter === undefined ? {} : { notAfter: n ?? legacyNotAfter }),
      ...(m === undefined ? {} : { interstitialNote: m }),
    }),
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

export type ParsedPayloadInput = {
  payload: string;
  executionUrl?: string;
};

export function parsePayloadInput(input: string): ParsedPayloadInput {
  const trimmed = input.trim();
  if (/^[12][A-Za-z0-9_-]+$/u.test(trimmed)) {
    return { payload: trimmed };
  }

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/([rd])\/([^/]+)$/u);
    if (!match?.[1] || !match[2]) {
      throw new Error("missing payload path");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { payload: match[2] };
    }
    if (match[1] === "d") {
      url.pathname = url.pathname.replace(/\/d\/([^/]+)$/u, "/r/$1");
    }
    url.search = "";
    url.hash = "";
    return { payload: match[2], executionUrl: url.href };
  } catch (error) {
    throw new Error("Expected a smartlink URL or encoded payload.", { cause: error });
  }
}

export function payloadFromInput(input: string): string {
  return parsePayloadInput(input).payload;
}
