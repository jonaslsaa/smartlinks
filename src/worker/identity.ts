import { z } from "zod";
import {
  type AuthorCertificate,
  GITHUB_OAUTH_CLIENT_ID,
  issueAuthorCertificate,
  verifyAuthorCertificate,
} from "../shared/author.js";
import { HttpError } from "./http.js";

export const AUTHOR_CERTIFICATE_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

export const certificateRequestSchema = z
  .object({
    deviceCode: z.string().min(20).max(200),
    publicKey: z.string().min(40).max(100),
  })
  .strict();

const githubTokenSchema = z.object({ access_token: z.string().min(1) });
const githubPendingSchema = z.object({
  error: z.enum(["authorization_pending", "slow_down", "expired_token", "access_denied"]),
  interval: z.number().int().positive().optional(),
  error_description: z.string().optional(),
});
const githubUserSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().min(1).max(39),
});

type ExchangeResult =
  | { status: "pending"; interval: number }
  | { status: "authorized"; accessToken: string };

async function exchangeDeviceCode(
  deviceCode: string,
  fetchImpl: typeof fetch,
): Promise<ExchangeResult> {
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new HttpError(502, "GitHub authentication is temporarily unavailable.");
  }
  const body: unknown = await response.json();
  const token = githubTokenSchema.safeParse(body);
  if (token.success) {
    return { status: "authorized", accessToken: token.data.access_token };
  }
  const pending = githubPendingSchema.safeParse(body);
  if (!pending.success) {
    throw new HttpError(502, "GitHub returned an unexpected authentication response.");
  }
  if (pending.data.error === "authorization_pending" || pending.data.error === "slow_down") {
    return {
      status: "pending",
      interval: pending.data.interval ?? (pending.data.error === "slow_down" ? 10 : 5),
    };
  }
  throw new HttpError(
    400,
    pending.data.error === "access_denied"
      ? "GitHub authorization was denied."
      : "The GitHub authorization code expired. Run smartlinks login again.",
  );
}

async function githubIdentity(accessToken: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "smartlinks-runtime",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new HttpError(502, "GitHub could not verify this account.");
  }
  const user = githubUserSchema.parse(await response.json());
  return { githubId: user.id, githubLogin: user.login };
}

export async function exchangeGithubIdentity(options: {
  authorPublicKey: string;
  deviceCode: string;
  issuerKeyId: number;
  issuerPrivateKey: string;
  issuerPublicKey: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}): Promise<
  { status: "pending"; interval: number } | { status: "issued"; certificate: AuthorCertificate }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const exchange = await exchangeDeviceCode(options.deviceCode, fetchImpl);
  if (exchange.status === "pending") {
    return exchange;
  }
  const identity = await githubIdentity(exchange.accessToken, fetchImpl);
  const issuedAt = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const certificate = await issueAuthorCertificate({
    authorPublicKey: options.authorPublicKey,
    identity,
    issuerKeyId: options.issuerKeyId,
    issuerPrivateKey: options.issuerPrivateKey,
    issuedAt,
    expiresAt: issuedAt + AUTHOR_CERTIFICATE_LIFETIME_SECONDS,
  });
  const verification = await verifyAuthorCertificate(certificate, {
    issuerPublicKeys: { [options.issuerKeyId]: options.issuerPublicKey },
    nowSeconds: issuedAt,
  });
  if (verification.status !== "valid") {
    throw new HttpError(503, "Author certificate signing is misconfigured.");
  }
  return { status: "issued", certificate };
}
