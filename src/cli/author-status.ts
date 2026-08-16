import {
  type AuthorCertificateVerification,
  verifyAuthorCertificate,
  verifyAuthorCredential,
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
type ValidStatus = Omit<CertificateStatus, "status"> & { status: "valid"; service: string };
type ExpiredStatus = Omit<CertificateStatus, "status"> & { status: "expired"; service: string };
type ScopedInvalidStatus = InvalidStatus & { service?: string };
type WrongRuntimeStatus = Omit<ValidStatus, "status"> & {
  status: "wrong-runtime";
  selectedService: string;
};

export type AuthorStatus =
  | { status: "missing" }
  | ValidStatus
  | ExpiredStatus
  | WrongRuntimeStatus
  | ScopedInvalidStatus;

export type AuthorInspection =
  | { status: Exclude<AuthorStatus, ValidStatus> }
  | { status: ValidStatus; author: StoredAuthor };

export async function inspectConfiguredAuthor(selectedService: string): Promise<AuthorInspection> {
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
    return { status: { ...status, service: author.service } };
  }
  if (status.status === "expired") {
    return { status: { ...status, status: "expired", service: author.service } };
  }
  const validStatus: ValidStatus = { ...status, status: "valid", service: author.service };
  try {
    await verifyAuthorCredential(author.certificate, authorKey(author));
    if (author.service !== selectedService) {
      return {
        status: {
          ...validStatus,
          status: "wrong-runtime",
          selectedService,
        },
      };
    }
    return { status: validStatus, author };
  } catch {
    return {
      status: {
        status: "invalid",
        githubId: validStatus.githubId,
        githubLogin: validStatus.githubLogin,
        service: author.service,
        reason: "The stored author signing key is invalid. Run smartlinks login again.",
      },
    };
  }
}

export async function configuredAuthorForBuild(service: string): Promise<StoredAuthor | undefined> {
  const inspection = await inspectConfiguredAuthor(service);
  if ("author" in inspection) {
    return inspection.author;
  }

  const { status } = inspection;
  if (status.status === "missing") {
    return undefined;
  }
  if (status.status === "expired") {
    throw new Error(
      "The local author certificate has expired. Run smartlinks login again or use --no-sign.",
    );
  }
  if (status.status === "wrong-runtime") {
    throw new Error(
      `The local author identity belongs to ${status.service}, not ${status.selectedService}. Run smartlinks login for this runtime or use --no-sign.`,
    );
  }
  throw new Error(
    `The local author identity is invalid: ${status.reason} Use --no-sign to build unsigned.`,
  );
}
