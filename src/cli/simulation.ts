import type { DecodedPayload } from "../shared/codec.js";
import {
  createGuardedFetch,
  type FetchImplementation,
  type GuestFetch,
} from "../shared/guarded-fetch.js";
import { type PayloadFacts, payloadFacts } from "../shared/payload-facts.js";

const SIMULATED_BODY = "{}";
const SIMULATED_HEADERS = { "content-type": "application/json" } as const;
const SIMULATED_STATUS = 200;
const MAX_HUMAN_FIELD_LENGTH = 96;

export type SimulationInputs = {
  method: string;
  params: Record<string, string[]>;
  headers: Record<string, string>;
  body: string | null;
};

type SimulatedFetchRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type SimulationEvent =
  | {
      type: "fetch";
      request: SimulatedFetchRequest;
      response: {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
    }
  | {
      type: "fetch-blocked";
      request: Pick<SimulatedFetchRequest, "url" | "method">;
      reason: string;
    }
  | {
      type: "compile";
      hop: number;
      artifact: PayloadFacts & { payloadCharacters: number };
    };

export type SimulationResponse = {
  status: number;
  headers: Record<string, string>;
} & (
  | { body: string }
  | { bodyBase64: string; bodyBytes: number }
  | { bodyRedacted: string; bodyBytes: number }
);

type SimulationReportBase = {
  simulated: true;
  inputs: SimulationInputs;
  events: SimulationEvent[];
};

export type SimulationReport = SimulationReportBase &
  ({ response: SimulationResponse; error?: never } | { error: string; response?: never });

type SimulationEventSlot = { event?: SimulationEvent };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown local execution error.";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requestMethod(options: unknown): string {
  if (
    typeof options === "object" &&
    options !== null &&
    "method" in options &&
    typeof options.method === "string"
  ) {
    return options.method.toUpperCase();
  }
  return "GET";
}

export class LocalSimulation {
  readonly #events: SimulationEventSlot[] = [];
  readonly #secrets: Array<readonly [name: string, value: string]> = [];
  readonly #inputs: SimulationInputs;
  #fetchQueue: Promise<void> = Promise.resolve();

  constructor(inputs: SimulationInputs, secrets: Record<string, string>) {
    this.addSecrets(secrets);
    this.#inputs = inputs;
  }

  addSecrets(secrets: Record<string, string>): void {
    for (const [name, value] of Object.entries(secrets)) {
      if (
        value.length > 0 &&
        !this.#secrets.some(([knownName, knownValue]) => knownName === name && knownValue === value)
      ) {
        this.#secrets.push([name, value]);
      }
    }
  }

  #redactionPattern(): { labels: Map<string, string>; pattern: RegExp } | undefined {
    const labels = new Map<string, string>();
    const entries = [...this.#secrets].reverse();
    for (const [name, value] of entries) {
      const jsonEscaped = JSON.stringify(value).slice(1, -1);
      const queryEscaped = new URLSearchParams([["value", value]])
        .toString()
        .slice("value=".length);
      for (const candidate of [value, encodeURIComponent(value), queryEscaped, jsonEscaped]) {
        if (candidate.length > 0 && !labels.has(candidate)) {
          labels.set(candidate, `[secret:${name}]`);
        }
      }
    }
    if (labels.size === 0) {
      return undefined;
    }
    const alternatives = [...labels.keys()]
      .sort((left, right) => right.length - left.length || left.localeCompare(right))
      .map(escapeRegex)
      .join("|");
    return { labels, pattern: new RegExp(alternatives, "gu") };
  }

  redact(value: string): string {
    const redaction = this.#redactionPattern();
    return redaction
      ? value.replace(redaction.pattern, (match) => redaction.labels.get(match) ?? match)
      : value;
  }

  #redactRecord(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([name, value]) => [this.redact(name), this.redact(value)]),
    );
  }

  #redactInputs(inputs: SimulationInputs): SimulationInputs {
    return {
      method: inputs.method,
      params: Object.fromEntries(
        Object.entries(inputs.params).map(([name, values]) => [
          this.redact(name),
          values.map((value) => this.redact(value)),
        ]),
      ),
      headers: this.#redactRecord(inputs.headers),
      body: inputs.body === null ? null : this.redact(inputs.body),
    };
  }

  #redactEvent(event: SimulationEvent): SimulationEvent {
    if (event.type === "fetch") {
      return {
        type: "fetch",
        request: {
          url: this.redact(event.request.url),
          method: event.request.method,
          headers: this.#redactRecord(event.request.headers),
          body: event.request.body === null ? null : this.redact(event.request.body),
        },
        response: {
          status: event.response.status,
          headers: this.#redactRecord(event.response.headers),
          body: this.redact(event.response.body),
        },
      };
    }
    if (event.type === "fetch-blocked") {
      return {
        type: "fetch-blocked",
        request: {
          url: this.redact(event.request.url),
          method: event.request.method,
        },
        reason: this.redact(event.reason),
      };
    }
    return {
      type: "compile",
      hop: event.hop,
      artifact: { ...event.artifact, sealedSecrets: [...event.artifact.sealedSecrets] },
    };
  }

  #reportEvents(): SimulationEvent[] {
    return this.#events.map(({ event }, index) => {
      if (!event) {
        throw new Error(`Simulation trace step ${index + 1} did not finish.`);
      }
      return this.#redactEvent(event);
    });
  }

  createGuestFetch(blockedHostnames: readonly string[]): GuestFetch {
    let activeSlot: SimulationEventSlot | undefined;
    const fetchImpl: FetchImplementation = async (url, init) => {
      const headers = Object.fromEntries(new Headers(init.headers));
      if (!activeSlot) {
        throw new Error("Simulation fetch executed without a trace slot.");
      }
      activeSlot.event = {
        type: "fetch",
        request: {
          url: url.href,
          method: init.method ?? "GET",
          headers,
          body: typeof init.body === "string" ? init.body : null,
        },
        response: {
          status: SIMULATED_STATUS,
          headers: { ...SIMULATED_HEADERS },
          body: SIMULATED_BODY,
        },
      };
      return new Response(SIMULATED_BODY, {
        status: SIMULATED_STATUS,
        headers: SIMULATED_HEADERS,
      });
    };
    const guardedFetch = createGuardedFetch({ fetchImpl, blockedHostnames });

    return (url, options) => {
      const slot: SimulationEventSlot = {};
      this.#events.push(slot);
      const result = this.#fetchQueue.then(async () => {
        activeSlot = slot;
        try {
          return await guardedFetch(url, options);
        } catch (error) {
          slot.event = {
            type: "fetch-blocked",
            request: { url, method: requestMethod(options) },
            reason: errorMessage(error),
          };
          throw error;
        } finally {
          activeSlot = undefined;
        }
      });
      this.#fetchQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
  }

  recordCompile(decoded: DecodedPayload, payloadCharacters: number, hop: number): void {
    this.#events.push({
      event: {
        type: "compile",
        hop,
        artifact: { ...payloadFacts(decoded), payloadCharacters },
      },
    });
  }

  async success(response: Response, binary: boolean): Promise<SimulationReport> {
    await this.#fetchQueue;
    const headers = this.#redactRecord(Object.fromEntries(response.headers));
    let body:
      | { body: string }
      | { bodyBase64: string; bodyBytes: number }
      | { bodyRedacted: string; bodyBytes: number };
    if (binary) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const bodyBase64 = bytes.toString("base64");
      const redacted = this.redact(bodyBase64);
      body =
        redacted === bodyBase64
          ? { bodyBase64, bodyBytes: bytes.byteLength }
          : { bodyRedacted: redacted, bodyBytes: bytes.byteLength };
    } else {
      body = { body: this.redact(await response.text()) };
    }
    return {
      simulated: true,
      inputs: this.#redactInputs(this.#inputs),
      events: this.#reportEvents(),
      response: { status: response.status, headers, ...body },
    };
  }

  async failure(error: unknown): Promise<SimulationReport> {
    await this.#fetchQueue;
    return {
      simulated: true,
      inputs: this.#redactInputs(this.#inputs),
      events: this.#reportEvents(),
      error: this.redact(errorMessage(error)),
    };
  }
}

export function formatSimulationReport(report: SimulationReport): string {
  let truncated = false;
  const preview = (value: string) => {
    if (value.length <= MAX_HUMAN_FIELD_LENGTH) {
      return value;
    }
    truncated = true;
    return `${value.slice(0, MAX_HUMAN_FIELD_LENGTH)}… (${(value.length - MAX_HUMAN_FIELD_LENGTH).toLocaleString()} characters omitted)`;
  };
  const lines = [
    `Input · ${report.inputs.method}`,
    ...(Object.keys(report.inputs.params).length
      ? [`Parameters · ${preview(JSON.stringify(report.inputs.params))}`]
      : []),
    ...(Object.keys(report.inputs.headers).length
      ? [`Headers · ${preview(JSON.stringify(report.inputs.headers))}`]
      : []),
    ...(report.inputs.body === null ? [] : [`Body · ${preview(report.inputs.body)}`]),
  ];

  for (const [index, event] of report.events.entries()) {
    const step = `Step ${index + 1}`;
    if (event.type === "fetch") {
      lines.push(`${step} · Fetch · ${event.request.method} ${preview(event.request.url)}`);
      if (Object.keys(event.request.headers).length) {
        lines.push(`  Headers · ${preview(JSON.stringify(event.request.headers))}`);
      }
      if (event.request.body !== null) {
        lines.push(`  Body · ${preview(event.request.body)}`);
      }
      lines.push(`  Synthetic response · HTTP ${event.response.status} · ${event.response.body}`);
    } else if (event.type === "fetch-blocked") {
      lines.push(
        `${step} · Fetch blocked · ${event.request.method} ${preview(event.request.url)}`,
        `  ${preview(event.reason)}`,
      );
    } else {
      const secrets = event.artifact.sealedSecrets.join(", ") || "none";
      lines.push(
        `${step} · Compiled child ${event.hop} · payload v${event.artifact.payloadVersion} · ${event.artifact.payloadCharacters.toLocaleString()} characters · sealed secrets: ${secrets}`,
      );
    }
  }

  if (report.response) {
    lines.push(`Final response · HTTP ${report.response.status}`);
    if (Object.keys(report.response.headers).length) {
      lines.push(`  Headers · ${preview(JSON.stringify(report.response.headers))}`);
    }
    lines.push(
      "body" in report.response
        ? `  Body · ${preview(report.response.body || "(empty)")}`
        : `  Body · ${report.response.bodyBytes.toLocaleString()} binary bytes`,
    );
  } else {
    lines.push(`Execution error · ${preview(report.error)}`);
  }
  if (truncated) {
    lines.push("Terminal preview truncated · use --json for the complete simulation report");
  }
  return lines.join("\n");
}
