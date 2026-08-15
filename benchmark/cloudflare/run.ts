import { performance } from "node:perf_hooks";
import { z } from "zod";
import { encodePayload, MAX_PAYLOAD_LENGTH } from "../../src/shared/codec.js";
import { minifyScriptBody } from "../../src/shared/script.js";
import { type PublicKey, sealSecret } from "../../src/shared/seal.js";

const REQUESTS_PER_ROUTE = 30;
const WARMUP_REQUESTS = 5;

type BenchmarkCase = {
  name: string;
  payload: string;
  routes: readonly ("d" | "r")[];
};

type RequestResult = {
  milliseconds: number;
  status: number;
};

function deterministicText(length: number): string {
  let state = 0x6d2b79f5;
  let result = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += alphabet[state >>> 26];
  }
  return result;
}

async function payloadNear(targetLength: number): Promise<string> {
  let low = 0;
  let high = 12_000;
  let best = "";

  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const source = `return {body:${JSON.stringify(deterministicText(length))}}`;
    let payload: string;
    try {
      payload = encodePayload({ s: await minifyScriptBody(source) });
    } catch (error) {
      if (error instanceof Error && error.message.includes("encoded payload")) {
        high = length - 1;
        continue;
      }
      throw error;
    }
    if (payload.length <= targetLength) {
      best = payload;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }

  if (!best) {
    throw new Error(`Could not create a payload near ${targetLength} characters.`);
  }
  return best;
}

const publicKeySchema = z.object({
  keyId: z.number().int().min(1).max(255),
  publicKey: z.string().min(1),
});

async function fetchPublicKey(origin: string): Promise<PublicKey | undefined> {
  const response = await fetch(`${origin}/pk`);
  if (response.status === 503) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`The benchmark Worker returned HTTP ${response.status} from /pk.`);
  }
  return publicKeySchema.parse(await response.json());
}

async function secretCase(publicKey: PublicKey, count: number): Promise<BenchmarkCase> {
  const source = await minifyScriptBody('return {body:ctx.secrets.SECRET_0 ?? "missing"}');
  const entries = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const name = `SECRET_${index}`;
      const value = deterministicText(32 + index).slice(0, 32);
      return [name, await sealSecret(value, source, publicKey)] as const;
    }),
  );
  return {
    name: `${count}-secret${count === 1 ? "" : "s"}`,
    payload: encodePayload({ s: source, k: Object.fromEntries(entries) }),
    routes: ["r"],
  };
}

async function createCases(origin: string): Promise<BenchmarkCase[]> {
  const cases: BenchmarkCase[] = [
    {
      name: "tiny",
      payload: encodePayload({ s: await minifyScriptBody('return {body:"ok"}') }),
      routes: ["d", "r"],
    },
    { name: "half-limit", payload: await payloadNear(3_900), routes: ["d", "r"] },
    {
      name: "near-limit",
      payload: await payloadNear(MAX_PAYLOAD_LENGTH - 50),
      routes: ["d", "r"],
    },
  ];

  const publicKey = await fetchPublicKey(origin);
  if (publicKey) {
    cases.push(
      await secretCase(publicKey, 1),
      await secretCase(publicKey, 4),
      await secretCase(publicKey, 8),
    );
  }
  return cases;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function request(
  url: string,
  benchmarkCase: string,
  phase: "warmup" | "measured",
): Promise<RequestResult> {
  const started = performance.now();
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("__phase", phase);
  const response = await fetch(requestUrl, {
    headers: { "x-smartlinks-benchmark": benchmarkCase },
  });
  await response.arrayBuffer();
  return { milliseconds: performance.now() - started, status: response.status };
}

async function runRoute(origin: string, route: "d" | "r", benchmarkCase: BenchmarkCase) {
  const url = `${origin}/${route}/${benchmarkCase.payload}?__case=${benchmarkCase.name}`;
  for (let index = 0; index < WARMUP_REQUESTS; index += 1) {
    await request(url, benchmarkCase.name, "warmup");
  }

  const results: RequestResult[] = [];
  for (let index = 0; index < REQUESTS_PER_ROUTE; index += 1) {
    results.push(await request(url, benchmarkCase.name, "measured"));
  }

  const timings = results.map((result) => result.milliseconds);
  const statuses: Record<string, number> = {};
  for (const result of results) {
    const status = String(result.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return {
    case: benchmarkCase.name,
    route,
    payloadCharacters: benchmarkCase.payload.length,
    statuses,
    localWallTimeMs: {
      p50: percentile(timings, 0.5),
      p95: percentile(timings, 0.95),
      max: Math.max(...timings),
    },
  };
}

async function main() {
  const origin = process.env.BENCHMARK_ORIGIN?.replace(/\/$/u, "");
  if (!origin?.startsWith("https://")) {
    throw new Error("Set BENCHMARK_ORIGIN to the temporary Worker's HTTPS origin.");
  }

  const cases = await createCases(origin);
  console.log(
    JSON.stringify(
      {
        origin,
        requestsPerRoute: REQUESTS_PER_ROUTE,
        warmupRequests: WARMUP_REQUESTS,
        cases: cases.map(({ name, payload, routes }) => ({
          name,
          payloadCharacters: payload.length,
          routes,
        })),
      },
      null,
      2,
    ),
  );

  for (const benchmarkCase of cases) {
    for (const route of benchmarkCase.routes) {
      console.log(JSON.stringify(await runRoute(origin, route, benchmarkCase), null, 2));
    }
  }
}

await main();
