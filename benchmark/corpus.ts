import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLOUDFLARE_TEMPLATES_COMMIT = "7a0bc8f9a10dc9233964bb8d834beff585d56f08";
const RAW_BASE = `https://raw.githubusercontent.com/cloudflare/templates/${CLOUDFLARE_TEMPLATES_COMMIT}`;
const CACHE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), ".cache");

export type CorpusEntry = {
  id: string;
  path: string;
  sha256: string;
};

export type CorpusSample = CorpusEntry & {
  source: string;
};

export const CORPUS: readonly CorpusEntry[] = [
  {
    id: "tiny-formatters",
    path: "mysql-hyperdrive-template/public/js/utils/formatters.js",
    sha256: "fb0246d857c4bf37f16acd34418508b4f029dcf42aee524db4d2db3974603118",
  },
  {
    id: "small-api",
    path: "react-postgres-fullstack-template/api/index.js",
    sha256: "db580eea2f6602fdeaefdadbeb3048240f5f88e83172d9000b1b18b8d3c482d7",
  },
  {
    id: "small-service",
    path: "mysql-hyperdrive-template/public/js/services/api.js",
    sha256: "b4d86028a10210100f99144b9c96e3600f181885bf517bda8b7663b17394dd0b",
  },
  {
    id: "medium-chat",
    path: "llm-chat-app-template/public/chat.js",
    sha256: "1894254f9243ef16d4d7f7d48a503650fd1e0902b1cfb443519abd2e6d8d2623",
  },
  {
    id: "medium-renderer",
    path: "nlweb-template/public/json-renderer.js",
    sha256: "ef908631a449dd4b2e5a8f8ebeaf6d65bf784793375d36715ecfa0fcdfeea837",
  },
  {
    id: "large-setup",
    path: "workers-for-platforms-template/scripts/setup.js",
    sha256: "5918cf5d0fa29ddd68bb4fc6356dd19bed38d1b54f0d4dc22a81e9899e870882",
  },
  {
    id: "oversize-interface",
    path: "nlweb-template/public/fp-chat-interface.js",
    sha256: "a54b2e732fe81a1ab4326a58bf6e8a2e9f07b21440880c57cd8b54757f79b819",
  },
] as const;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadEntry(entry: CorpusEntry): Promise<CorpusSample> {
  const cachePath = join(CACHE_DIRECTORY, `${entry.id}.js`);
  let bytes: Uint8Array;

  try {
    bytes = await readFile(cachePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }

    const response = await fetch(`${RAW_BASE}/${entry.path}`);
    if (!response.ok) {
      throw new Error(`Could not download ${entry.path}: HTTP ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  const actualHash = hash(bytes);
  if (actualHash !== entry.sha256) {
    throw new Error(
      `${entry.id} failed its SHA-256 check: expected ${entry.sha256}, received ${actualHash}`,
    );
  }

  await mkdir(CACHE_DIRECTORY, { recursive: true });
  await writeFile(cachePath, bytes);
  return { ...entry, source: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

export async function loadCorpus(): Promise<CorpusSample[]> {
  return Promise.all(CORPUS.map(loadEntry));
}
