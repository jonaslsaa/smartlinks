export const RUNTIME_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const SMARTLINKS_PREVIEW_HEADER = "x-smartlinks-preview";

const RUNTIME_SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

/** Applies the security policy owned by the Smartlinks runtime to a final response. */
export function hardenResponse(response: Response): Response {
  const headers = new Headers(response.headers);

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
