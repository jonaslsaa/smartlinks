import { deflateRawSync } from "node:zlib";
import { deflateSync } from "fflate";
import {
  CURRENT_PAYLOAD_VERSION,
  type Envelope,
  encodePayloadWith,
  type PayloadVersion,
} from "../shared/codec.js";

export function encodePayloadForCli(
  input: Envelope,
  version: PayloadVersion = CURRENT_PAYLOAD_VERSION,
): string {
  // Neither implementation wins for every JavaScript shape. Authoring can spend
  // the extra CPU once so every execution keeps the shortest compatible payload.
  return encodePayloadWith(
    input,
    [
      (serialized) => deflateRawSync(serialized, { level: 9 }),
      (serialized) => deflateSync(serialized, { level: 9 }),
    ],
    version,
  );
}
