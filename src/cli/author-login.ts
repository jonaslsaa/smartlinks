import { z } from "zod";
import {
  type AuthorCertificate,
  authorCertificateSchema,
  GITHUB_OAUTH_CLIENT_ID,
  generateAuthorKeyPair,
} from "../shared/author.js";

const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const pendingCertificateSchema = z.object({
  status: z.literal("pending"),
  interval: z.number().int().positive(),
});

const issuedCertificateSchema = z.object({
  certificate: z.unknown(),
});

export type DeviceCode = z.infer<typeof deviceCodeSchema>;

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return new Error(
    typeof body?.error === "string"
      ? body.error
      : `Author authentication failed with HTTP ${response.status}.`,
  );
}

export async function requestGithubDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCode> {
  const response = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return deviceCodeSchema.parse(await response.json());
}

export async function requestAuthorCertificate(
  service: string,
  deviceCode: string,
  publicKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  { status: "pending"; interval: number } | { status: "issued"; certificate: AuthorCertificate }
> {
  const response = await fetchImpl(`${service}/auth/github/certificate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode, publicKey }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 202) {
    return pendingCertificateSchema.parse(await response.json());
  }
  if (!response.ok) {
    throw await responseError(response);
  }
  const parsed = issuedCertificateSchema.parse(await response.json());
  return { status: "issued", certificate: authorCertificateSchema.parse(parsed.certificate) };
}

export async function beginAuthorLogin(fetchImpl: typeof fetch = fetch): Promise<{
  device: DeviceCode;
  key: Awaited<ReturnType<typeof generateAuthorKeyPair>>;
}> {
  const [device, key] = await Promise.all([
    requestGithubDeviceCode(fetchImpl),
    generateAuthorKeyPair(),
  ]);
  return { device, key };
}
