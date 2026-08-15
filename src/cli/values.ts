import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import { toBase64Url } from "../shared/bytes.js";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function splitAssignment(value: string, label: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error(`${label} must use NAME=value.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function assignments(values: readonly string[], label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const [name, assignedValue] = splitAssignment(value, label);
    if (name in result) {
      throw new Error(`${label} ${name} was provided more than once.`);
    }
    result[name] = assignedValue;
  }
  return result;
}

export async function resolveSecrets(
  values: readonly string[],
  options: { prompt: boolean },
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  for (const value of values) {
    const separator = value.indexOf("=");
    const name = separator === -1 ? value : value.slice(0, separator);
    if (!SECRET_NAME.test(name)) {
      throw new Error(
        `Invalid secret name ${JSON.stringify(name)}. Use an uppercase environment name.`,
      );
    }
    if (name in secrets) {
      throw new Error(`Secret ${name} was provided more than once.`);
    }

    if (separator !== -1) {
      const assigned = value.slice(separator + 1);
      secrets[name] = assigned === "@random" ? toBase64Url(randomBytes(32)) : assigned;
      continue;
    }

    const environmentValue = process.env[name];
    if (environmentValue !== undefined) {
      secrets[name] = environmentValue;
      continue;
    }

    if (!options.prompt || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Secret ${name} is not set in the environment and cannot be prompted for.`);
    }

    const prompted = await p.password({
      message: `Value for ${name}`,
      validate: (input) => (input ? undefined : "A secret value is required."),
    });
    if (p.isCancel(prompted)) {
      throw new Error("Cancelled.");
    }
    secrets[name] = prompted;
  }

  return secrets;
}

export function normalizeServiceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error("The service must be an absolute URL.", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The service URL must use http: or https:.");
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/u, "");
}
