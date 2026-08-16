const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

export function isBodylessStatus(status: number): boolean {
  return BODYLESS_STATUSES.has(status);
}
