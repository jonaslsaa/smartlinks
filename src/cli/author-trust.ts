import { AUTHOR_CA_PUBLIC_KEYS } from "../shared/author.js";

export function trustedAuthorIssuerKeys(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<number, string>> {
  const keys: Record<number, string> = { ...AUTHOR_CA_PUBLIC_KEYS };
  for (const [name, value] of Object.entries(environment)) {
    const match = name.match(/^SMARTLINKS_AUTHOR_CA_PUBLIC_KEY_(\d{1,3})$/u);
    if (!match?.[1] || !value) {
      continue;
    }
    const keyId = Number(match[1]);
    if (Number.isInteger(keyId) && keyId >= 1 && keyId <= 255) {
      const hostedKey = AUTHOR_CA_PUBLIC_KEYS[keyId];
      if (hostedKey !== undefined && hostedKey !== value) {
        throw new Error(
          `Author issuer key ID ${keyId} is reserved by hosted Smartlinks. Choose a different self-hosted key ID.`,
        );
      }
      keys[keyId] = value;
    }
  }
  return keys;
}
