import { z } from "zod";
import { MAX_NOT_AFTER } from "../shared/codec.js";

const DURATION = /^(\d+)(s|m|h|d|w)$/iu;
const ABSOLUTE_EXPIRY = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const EXPECTED_EXPIRY = "Expected a duration such as 30m, 1h, or 7d, or an absolute ISO 8601 date.";

function assertFutureUnixSeconds(notAfter: number, nowSeconds: number): number {
  if (!Number.isSafeInteger(notAfter) || notAfter <= nowSeconds || notAfter > MAX_NOT_AFTER) {
    throw new Error("The expiry must be a valid future date.");
  }
  return notAfter;
}

function secondsPerUnit(unit: string): number {
  switch (unit.toLowerCase()) {
    case "s":
      return 1;
    case "m":
      return 60;
    case "h":
      return 60 * 60;
    case "d":
      return 24 * 60 * 60;
    case "w":
      return 7 * 24 * 60 * 60;
    default:
      throw new Error(EXPECTED_EXPIRY);
  }
}

export function parseExpiry(value: string, nowMs = Date.now()): number {
  const nowSeconds = Math.floor(nowMs / 1_000);
  const duration = value.match(DURATION);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2];
    if (unit === undefined) {
      throw new Error(EXPECTED_EXPIRY);
    }
    return assertFutureUnixSeconds(nowSeconds + amount * secondsPerUnit(unit), nowSeconds);
  }

  const absolute = ABSOLUTE_EXPIRY.safeParse(value);
  if (!absolute.success) {
    throw new Error(EXPECTED_EXPIRY);
  }
  const timestamp = Date.parse(value.includes("T") ? value : `${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(EXPECTED_EXPIRY);
  }
  return assertFutureUnixSeconds(Math.floor(timestamp / 1_000), nowSeconds);
}
