const MAX_DECODE_INPUT_BYTES = 16_384;

export async function readDecodeInput(input: string): Promise<string> {
  if (input !== "-") {
    return input;
  }
  if (process.stdin.isTTY) {
    throw new Error("decode - requires piped or redirected stdin.");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const stdin: AsyncIterable<unknown> = process.stdin;
  for await (const chunk of stdin) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : undefined;
    if (!bytes) {
      throw new Error("Could not read decode input from stdin.");
    }
    length += bytes.byteLength;
    if (length > MAX_DECODE_INPUT_BYTES) {
      throw new Error("Decode input from stdin exceeds the 16 KB limit.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}
