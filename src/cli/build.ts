import { interstitialNoteSchema } from "../shared/codec.js";
import { compiledChildSource } from "../shared/mint.js";
import { validateScript } from "../shared/sandbox.js";
import { minifyFunctionExpression, minifyScriptBody, wrapScriptBody } from "../shared/script.js";
import { artifactSecretBinding, type PublicKey, sealSecret } from "../shared/seal.js";
import { extractCompileClosures } from "./compile.js";
import { encodePayloadForCli } from "./encode.js";

export type CreateSmartlinkOptions = {
  source: string;
  service: string;
  interstitial?: boolean;
  interstitialNote?: string;
  notAfter?: number;
  secrets?: Record<string, string>;
  publicKey?: PublicKey;
  minify?: boolean;
  validate?: (version: "2", source: string) => Promise<void>;
};

export type CreatedSmartlink = {
  link: string;
  decoder: string;
  payload: string;
  source: string;
  closures: string[];
  interstitialNote?: string;
};

export async function prepareSmartlinkProgram(
  source: string,
  minify = true,
  validate: (version: "2", source: string) => Promise<void> = validateScript,
): Promise<{ source: string; closures: string[] }> {
  const extracted = await extractCompileClosures(source);
  const storedSource = minify
    ? await minifyScriptBody(extracted.source)
    : wrapScriptBody(extracted.source);
  const closures = minify
    ? await Promise.all(extracted.closures.map(minifyFunctionExpression))
    : extracted.closures;
  await validate("2", storedSource);
  await Promise.all(closures.map((closure) => validate("2", compiledChildSource(closure, "[]"))));
  return { source: storedSource, closures };
}

export async function createSmartlink(options: CreateSmartlinkOptions): Promise<CreatedSmartlink> {
  const { source, closures } = await prepareSmartlinkProgram(
    options.source,
    options.minify !== false,
    options.validate ?? validateScript,
  );
  const secretEntries = Object.entries(options.secrets ?? {});
  if (secretEntries.length > 0 && !options.publicKey) {
    throw new Error("A service public key is required to seal secrets.");
  }

  const publicKey = options.publicKey;
  let interstitialNote: string | undefined;
  if (options.interstitialNote !== undefined) {
    const parsedNote = interstitialNoteSchema.safeParse(options.interstitialNote);
    if (!parsedNote.success) {
      throw new Error(parsedNote.error.issues[0]?.message ?? "The interstitial note is invalid.");
    }
    interstitialNote = parsedNote.data;
  }
  const interstitial = options.interstitial === true || interstitialNote !== undefined;
  const envelope = {
    s: source,
    ...(interstitial ? { i: true as const } : {}),
    ...(closures.length ? { c: closures } : {}),
    ...(secretEntries.length ? { a: 1 as const } : {}),
    ...(options.notAfter !== undefined ? { notAfter: options.notAfter } : {}),
    ...(interstitialNote === undefined ? {} : { interstitialNote }),
  };
  const sealedEntries = publicKey
    ? await Promise.all(
        secretEntries.map(
          async ([name, value]) =>
            [
              name,
              await sealSecret(value, artifactSecretBinding("2", envelope, name), publicKey),
            ] as const,
        ),
      )
    : [];
  const payload = encodePayloadForCli({
    ...envelope,
    ...(sealedEntries.length ? { k: Object.fromEntries(sealedEntries) } : {}),
  });

  return {
    payload,
    source,
    closures,
    ...(interstitialNote === undefined ? {} : { interstitialNote }),
    link: `${options.service}/r/${payload}`,
    decoder: `${options.service}/d/${payload}`,
  };
}
