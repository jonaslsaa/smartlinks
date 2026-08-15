import { type DecodedPayload, formatNotAfter, isExpired } from "./codec.js";

export type PayloadFacts = {
  payloadVersion: number;
  interstitial: boolean;
  compileClosures: number;
  sealedSecrets: string[];
  notAfter: number | null;
  expiresAt: string | null;
  expired: boolean;
};

export function payloadFacts(decoded: DecodedPayload): PayloadFacts {
  const notAfter = decoded.envelope.notAfter;
  return {
    payloadVersion: Number(decoded.version),
    interstitial: decoded.envelope.i === true,
    compileClosures: decoded.envelope.c?.length ?? 0,
    sealedSecrets: Object.keys(decoded.envelope.k ?? {}),
    notAfter: notAfter ?? null,
    expiresAt: notAfter === undefined ? null : formatNotAfter(notAfter),
    expired: isExpired(notAfter),
  };
}
