import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type AuthorKeyPair, authorCertificateSchema } from "../shared/author.js";

const storedAuthorSchema = z
  .object({
    version: z.literal(1),
    privateKey: z.string().min(1),
    publicKey: z.string().min(1),
    certificate: authorCertificateSchema,
  })
  .strict();

export type StoredAuthor = z.infer<typeof storedAuthorSchema>;

export function authorConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.SMARTLINKS_CONFIG_DIR) {
    return join(environment.SMARTLINKS_CONFIG_DIR, "author.json");
  }
  if (process.platform === "win32") {
    return join(
      environment.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "smartlinks",
      "author.json",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "smartlinks", "author.json");
  }
  return join(
    environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "smartlinks",
    "author.json",
  );
}

export async function readStoredAuthor(
  path = authorConfigPath(),
): Promise<StoredAuthor | undefined> {
  const stats = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return undefined;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`The Smartlinks author credential at ${path} is not a regular file.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(
      `The Smartlinks author credential at ${path} is readable by other users. Restrict it to mode 0600.`,
    );
  }
  return storedAuthorSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeStoredAuthor(
  author: { key: AuthorKeyPair; certificate: StoredAuthor["certificate"] },
  path = authorConfigPath(),
): Promise<void> {
  const stored = storedAuthorSchema.parse({
    version: 1,
    privateKey: author.key.privateKey,
    publicKey: author.key.publicKey,
    certificate: author.certificate,
  });
  const directory = dirname(path);
  const temporary = join(directory, `.author-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      await chmod(temporary, 0o600);
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearStoredAuthor(path = authorConfigPath()): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function authorKey(author: StoredAuthor): AuthorKeyPair {
  return { privateKey: author.privateKey, publicKey: author.publicKey };
}
