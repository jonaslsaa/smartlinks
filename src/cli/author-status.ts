import {
  type AuthorCertificateVerification,
  verifyAuthorCertificate,
  verifyAuthorKeyPair,
} from "../shared/author.js";
import {
  authorKey,
  readStoredAuthor,
  type StoredAuthor,
  StoredAuthorAccessError,
} from "./author-store.js";
import { trustedAuthorIssuerKeys } from "./author-trust.js";

type CertificateStatus = Extract<AuthorCertificateVerification, { expiresAt: number }>;
type InvalidStatus = Extract<AuthorCertificateVerification, { status: "invalid" }>;
type ValidStatus = Omit<CertificateStatus, "status"> & { status: "valid" };
type ExpiredStatus = Omit<CertificateStatus, "status"> & { status: "expired" };

export type AuthorStatus = { status: "missing" } | ValidStatus | ExpiredStatus | InvalidStatus;

export type AuthorInspection =
  | { status: Exclude<AuthorStatus, ValidStatus> }
  | { status: ValidStatus; author: StoredAuthor };

export async function inspectConfiguredAuthor(): Promise<AuthorInspection> {
  let author: StoredAuthor | undefined;
  try {
    author = await readStoredAuthor();
  } catch (error) {
    return {
      status: {
        status: "invalid",
        reason:
          error instanceof StoredAuthorAccessError
            ? error.message
            : "The stored author credential is invalid. Run smartlinks login again.",
      },
    };
  }
  if (!author) {
    return { status: { status: "missing" } };
  }

  const status = await verifyAuthorCertificate(author.certificate, {
    issuerPublicKeys: trustedAuthorIssuerKeys(),
  });
  if (status.status === "invalid") {
    return { status };
  }
  if (status.status === "expired") {
    return { status: { ...status, status: "expired" } };
  }
  const validStatus: ValidStatus = { ...status, status: "valid" };
  try {
    await verifyAuthorKeyPair(authorKey(author));
    return { status: validStatus, author };
  } catch {
    return {
      status: {
        status: "invalid",
        githubId: validStatus.githubId,
        githubLogin: validStatus.githubLogin,
        reason: "The stored author signing key is invalid. Run smartlinks login again.",
      },
    };
  }
}

export async function requireConfiguredAuthor(): Promise<StoredAuthor> {
  const inspection = await inspectConfiguredAuthor();
  if ("author" in inspection) {
    return inspection.author;
  }
  const { status } = inspection;
  if (status.status === "missing") {
    throw new Error("No author identity is configured. Run smartlinks login first.");
  }
  if (status.status === "expired") {
    throw new Error("The local author certificate has expired. Run smartlinks login again.");
  }
  throw new Error(`The local author identity is invalid: ${status.reason}`);
}
