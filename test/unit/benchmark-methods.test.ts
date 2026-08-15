import { describe, expect, it } from "vitest";
import { COMPRESSORS, ENCODERS, inspectUrlEncoding, MINIFIERS } from "../../benchmark/methods.js";

const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

describe("benchmark methods", () => {
  it.each(ENCODERS)("round-trips $id", (encoder) => {
    const encoded = encoder.encode(bytes);
    expect(encoder.decode(encoded)).toEqual(bytes);
    expect(decodeURIComponent(`/r/${encodeURIComponent(encoded)}`.slice(3))).toBe(encoded);
  });

  it.each(COMPRESSORS)("round-trips $id", (compressor) => {
    const compressed = compressor.compress(bytes);
    expect(Uint8Array.from(compressor.decompress(compressed))).toEqual(bytes);
  });

  it.each(MINIFIERS)("produces output with $id", async (minifier) => {
    const result = await minifier.minify(
      'export default function greet(name) { return "Hello, " + name + "!"; }',
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it.each(ENCODERS.filter((encoder) => encoder.safety !== "escaped"))(
    "keeps raw $id output in one browser path segment",
    (encoder) => {
      expect(inspectUrlEncoding(encoder.encode(bytes)).directPathSafe).toBe(true);
    },
  );

  it("keeps native deflate output compatible with the current fflate decoder", () => {
    const native = COMPRESSORS.find((compressor) => compressor.id === "native-deflate-raw-9");
    const current = COMPRESSORS.find((compressor) => compressor.id === "fflate-deflate-raw-9");
    if (!native || !current) {
      throw new Error("The deflate benchmark methods are missing.");
    }
    expect(Uint8Array.from(current.decompress(native.compress(bytes)))).toEqual(bytes);
  });

  it("distinguishes direct path alphabets from delimiters", () => {
    expect(inspectUrlEncoding("abc-._~!$&+,;=:@XYZ").directPathSafe).toBe(true);
    expect(inspectUrlEncoding("abc/def").directPathSafe).toBe(false);
    expect(inspectUrlEncoding("abc?def").directPathSafe).toBe(false);
    expect(inspectUrlEncoding("abc#def").directPathSafe).toBe(false);
  });
});
