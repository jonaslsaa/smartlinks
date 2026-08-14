import { encodePayload } from "../shared/codec.js";
import { validateScript } from "../shared/sandbox.js";
import { minifyScriptBody, wrapScriptBody } from "../shared/script.js";
import { type PublicKey, sealSecret } from "../shared/seal.js";

export type CreateSmartlinkOptions = {
  source: string;
  service: string;
  interstitial?: boolean;
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
};

export async function createSmartlink(options: CreateSmartlinkOptions): Promise<CreatedSmartlink> {
  const source =
    options.minify === false
      ? wrapScriptBody(options.source)
      : await minifyScriptBody(options.source);
  await (options.validate ?? validateScript)("2", source);
  const secretEntries = Object.entries(options.secrets ?? {});
  if (secretEntries.length > 0 && !options.publicKey) {
    throw new Error("A service public key is required to seal secrets.");
  }

  const publicKey = options.publicKey;
  const sealedEntries = publicKey
    ? await Promise.all(
        secretEntries.map(
          async ([name, value]) => [name, await sealSecret(value, source, publicKey)] as const,
        ),
      )
    : [];
  const payload = encodePayload({
    s: source,
    ...(options.interstitial ? { i: true as const } : {}),
    ...(sealedEntries.length ? { k: Object.fromEntries(sealedEntries) } : {}),
  });

  return {
    payload,
    source,
    link: `${options.service}/r/${payload}`,
    decoder: `${options.service}/d/${payload}`,
  };
}
