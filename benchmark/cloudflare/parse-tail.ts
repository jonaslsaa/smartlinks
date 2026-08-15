import { createInterface } from "node:readline";
import { z } from "zod";

const tailEventSchema = z.object({
  cpuTime: z.number(),
  wallTime: z.number(),
  outcome: z.string(),
  event: z.object({
    request: z.object({ url: z.string() }),
    response: z.object({ status: z.number() }),
  }),
});

type Observation = {
  cpuTime: number;
  wallTime: number;
  outcome: string;
  status: number;
};

const observations = new Map<string, Observation[]>();
const expectedGroups = Number(process.env.EXPECTED_GROUPS ?? 0);
const expectedObservations = Number(process.env.EXPECTED_OBSERVATIONS ?? 0);
let json = "";
let depth = 0;
let inString = false;
let escaped = false;
let printed = false;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function printSummary() {
  if (printed) {
    return;
  }
  printed = true;

  for (const [key, values] of [...observations].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const cpuTimes = values.map(({ cpuTime }) => cpuTime);
    const wallTimes = values.map(({ wallTime }) => wallTime);
    console.log(
      JSON.stringify(
        {
          key,
          observations: values.length,
          outcomes: Object.fromEntries(
            [...new Set(values.map(({ outcome }) => outcome))].map((outcome) => [
              outcome,
              values.filter((value) => value.outcome === outcome).length,
            ]),
          ),
          statuses: Object.fromEntries(
            [...new Set(values.map(({ status }) => status))].map((status) => [
              status,
              values.filter((value) => value.status === status).length,
            ]),
          ),
          cpuTimeMs: {
            p50: percentile(cpuTimes, 0.5),
            p95: percentile(cpuTimes, 0.95),
            max: Math.max(...cpuTimes),
            over10ms: cpuTimes.filter((value) => value > 10).length,
          },
          wallTimeMs: {
            p50: percentile(wallTimes, 0.5),
            p95: percentile(wallTimes, 0.95),
            max: Math.max(...wallTimes),
          },
        },
        null,
        2,
      ),
    );
  }
}

function record(value: unknown) {
  const parsed = tailEventSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }

  const url = new URL(parsed.data.event.request.url);
  if (url.searchParams.get("__phase") !== "measured") {
    return;
  }
  const benchmarkCase = url.searchParams.get("__case");
  const route = url.pathname.split("/")[1];
  if (!benchmarkCase || (route !== "d" && route !== "r")) {
    return;
  }

  const key = `${benchmarkCase}/${route}`;
  const group = observations.get(key) ?? [];
  group.push({
    cpuTime: parsed.data.cpuTime,
    wallTime: parsed.data.wallTime,
    outcome: parsed.data.outcome,
    status: parsed.data.event.response.status,
  });
  observations.set(key, group);

  if (
    expectedGroups > 0 &&
    expectedObservations > 0 &&
    observations.size === expectedGroups &&
    [...observations.values()].every((values) => values.length >= expectedObservations)
  ) {
    printSummary();
    process.exit(0);
  }
}

function consume(character: string) {
  if (depth === 0) {
    if (character === "{") {
      json = character;
      depth = 1;
    }
    return;
  }

  json += character;
  if (inString) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
    }
    return;
  }

  if (character === '"') {
    inString = true;
  } else if (character === "{") {
    depth += 1;
  } else if (character === "}") {
    depth -= 1;
    if (depth === 0) {
      try {
        record(JSON.parse(json));
      } catch {
        // Wrangler may emit non-JSON status text around the event stream.
      }
      json = "";
    }
  }
}

const lines = createInterface({ input: process.stdin });
process.on("SIGINT", () => {
  printSummary();
  process.exit(130);
});
for await (const line of lines) {
  for (const character of `${line}\n`) {
    consume(character);
  }
}

printSummary();
