import {
  type DecodedPayload,
  type Envelope,
  invalidPayload,
  MAX_DECOMPRESSED_LENGTH,
  MAX_PAYLOAD_LENGTH,
  type PayloadVersion,
  parseDecompressedPayload,
  payloadFromCompressed,
  readCompressedPayload,
  readPayloadVersion,
  serializeEnvelope,
} from "../shared/codec.js";

const COMPRESSED_CHUNK_LENGTH = 256;

function compressedStream(compressed: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= compressed.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(offset + COMPRESSED_CHUNK_LENGTH, compressed.byteLength);
      controller.enqueue(compressed.subarray(offset, end));
      offset = end;
    },
  });
}

export async function inflateRawWithLimit(
  compressed: Uint8Array,
  maxOutputLength = MAX_DECOMPRESSED_LENGTH,
): Promise<Uint8Array> {
  const reader = compressedStream(compressed)
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      length += result.value.byteLength;
      if (length > maxOutputLength) {
        await reader.cancel("The decoded payload is too large.");
        throw new Error("The decoded payload is too large.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function decodeWorkerPayload(payload: string): Promise<DecodedPayload> {
  const version = readPayloadVersion(payload);
  try {
    const decompressed = await inflateRawWithLimit(readCompressedPayload(payload));
    return parseDecompressedPayload(version, decompressed);
  } catch (error) {
    throw invalidPayload(error);
  }
}

export async function encodeWorkerPayload(
  envelope: Envelope,
  version: PayloadVersion,
): Promise<string> {
  const serialized = serializeEnvelope(envelope);
  const reader = new Blob([Uint8Array.from(serialized)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      length += result.value.byteLength;
      if (length > MAX_PAYLOAD_LENGTH) {
        await reader.cancel("The encoded payload is too large.");
        throw new Error(
          `The encoded payload exceeds the ${MAX_PAYLOAD_LENGTH.toLocaleString()} character limit.`,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const compressed = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payloadFromCompressed(compressed, version);
}
