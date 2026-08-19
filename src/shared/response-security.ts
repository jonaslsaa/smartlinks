import {
  type ArtifactBrowserSettings,
  guestContentSecurityPolicy,
  isEmbeddable,
  referrerPolicy,
} from "./browser-policy.js";

export const RUNTIME_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const SMARTLINKS_PREVIEW_HEADER = "x-smartlinks-preview";

const RUNTIME_SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const RESERVED_RESPONSE_HEADERS = [
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-allow-private-network",
  "access-control-expose-headers",
  "access-control-max-age",
  "clear-site-data",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-embedder-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-opener-policy-report-only",
  "document-policy-report-only",
  "nel",
  "permissions-policy-report-only",
  "report-to",
  "reporting-endpoints",
  "set-cookie",
  SMARTLINKS_PREVIEW_HEADER,
] as const;

const CSP_REPORTING_DIRECTIVES = new Set(["report-to", "report-uri"]);

function removeCspReporting(headers: Headers): void {
  const value = headers.get("content-security-policy");
  if (value === null) {
    return;
  }
  const policies = value
    .split(",")
    .map((policy) =>
      policy
        .split(";")
        .map((entry) => entry.trim())
        .filter((entry) => {
          const name = entry.split(/\s/u, 1)[0]?.toLowerCase();
          return name !== undefined && !CSP_REPORTING_DIRECTIVES.has(name);
        })
        .join("; "),
    )
    .filter(Boolean);
  if (policies.length) {
    headers.set("content-security-policy", policies.join(", "));
  } else {
    headers.delete("content-security-policy");
  }
}

export function setCredentialFreeCorsHeaders(headers: Headers): void {
  for (const name of RESERVED_RESPONSE_HEADERS) {
    if (name.startsWith("access-control-")) {
      headers.delete(name);
    }
  }
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "*");
}

export function credentialFreeCorsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  setCredentialFreeCorsHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Applies the security policy owned by the Smartlinks runtime to a final response. */
export function hardenResponse(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const name of RESERVED_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  removeCspReporting(headers);
  // Separate CSP policies are enforced together, so an author can tighten the runtime policy
  // without weakening it.
  headers.append("content-security-policy", RUNTIME_CONTENT_SECURITY_POLICY);
  for (const [name, value] of Object.entries(RUNTIME_SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export type GuestResponseSecurity = ArtifactBrowserSettings & {
  service: string;
};

/** Applies an artifact's authenticated browser policy while preserving the shared-origin floor. */
export function hardenGuestResponse(response: Response, security: GuestResponseSecurity): Response {
  const headers = new Headers(response.headers);

  for (const name of RESERVED_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  removeCspReporting(headers);
  headers.append(
    "content-security-policy",
    guestContentSecurityPolicy(security.browser, security.service),
  );
  headers.set("referrer-policy", referrerPolicy(security.browser));
  headers.set("x-content-type-options", "nosniff");
  if (isEmbeddable(security.browser)) {
    // Preserve an author-supplied X-Frame-Options header as an optional extra restriction.
    if (!response.headers.has("x-frame-options")) {
      headers.delete("x-frame-options");
    }
  } else {
    headers.set("x-frame-options", "DENY");
  }
  if (security.cors === true) {
    setCredentialFreeCorsHeaders(headers);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** Answers an opted-in CORS preflight without spending an execution or rate-limit attempt. */
export function corsPreflightResponse(
  request: Request,
  security: GuestResponseSecurity,
): Response | undefined {
  if (security.cors !== true || request.method !== "OPTIONS") {
    return undefined;
  }
  const origin = request.headers.get("origin");
  const requestedMethod = request.headers.get("access-control-request-method");
  if (origin === null || requestedMethod === null) {
    return undefined;
  }
  if (!HTTP_TOKEN.test(requestedMethod)) {
    return hardenResponse(new Response(null, { status: 400 }));
  }
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (
    requestedHeaders !== null &&
    !requestedHeaders
      .split(",")
      .map((header) => header.trim())
      .every((header) => header !== "" && HTTP_TOKEN.test(header))
  ) {
    return hardenResponse(new Response(null, { status: 400 }));
  }

  const hardened = hardenResponse(
    new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        vary: "access-control-request-method, access-control-request-headers",
      },
    }),
  );
  const headers = new Headers(hardened.headers);
  setCredentialFreeCorsHeaders(headers);
  headers.set("access-control-allow-methods", requestedMethod.toUpperCase());
  if (requestedHeaders !== null) {
    headers.set("access-control-allow-headers", requestedHeaders);
  }
  headers.set("access-control-max-age", "600");
  return new Response(null, { status: hardened.status, headers });
}

/** Marks an already-hardened response whose preview path did not execute guest code. */
export function markPreviewResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(SMARTLINKS_PREVIEW_HEADER, "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
