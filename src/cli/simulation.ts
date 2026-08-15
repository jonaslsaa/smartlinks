import type { DecodedPayload } from "../shared/codec.js";
import {
  createGuardedFetch,
  type FetchImplementation,
  type GuestFetch,
} from "../shared/guarded-fetch.js";

const SIMULATED_BODY = "{}";
const SIMULATED_HEADERS = { "content-type": "application/json" } as const;
const SIMULATED_STATUS = 200;

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
      artifact: {
        payloadVersion: number;
        payloadCharacters: number;
        interstitial: boolean;
        sealedSecrets: string[];
        compileClosures: number;
        notAfter: number | null;
      };
    };

export type SimulationResponse = {
  status: number;
  headers: Record<string, string>;
} & ({ body: string } | { bodyBase64: string });

export type SimulationReport = {
  simulated: true;
  inputs: SimulationInputs;
  events: SimulationEvent[];
  response?: SimulationResponse;
  error?: string;
};

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
  readonly #events: SimulationEvent[] = [];
  readonly #secrets = new Map<string, string>();
  readonly #inputs: SimulationInputs;

  constructor(inputs: SimulationInputs, secrets: Record<string, string>) {
    this.addSecrets(secrets);
    this.#inputs = this.#redactInputs(inputs);
  }

  addSecrets(secrets: Record<string, string>): void {
    for (const [name, value] of Object.entries(secrets)) {
      if (value.length > 0) {
        this.#secrets.set(name, value);
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

  createGuestFetch(blockedHostnames: readonly string[]): GuestFetch {
    const fetchImpl: FetchImplementation = async (url, init) => {
      const headers = Object.fromEntries(new Headers(init.headers));
      this.#events.push({
        type: "fetch",
        request: {
          url: this.redact(url.href),
          method: init.method ?? "GET",
          headers: this.#redactRecord(headers),
          body: typeof init.body === "string" ? this.redact(init.body) : null,
        },
        response: {
          status: SIMULATED_STATUS,
          headers: { ...SIMULATED_HEADERS },
          body: SIMULATED_BODY,
        },
      });
      return new Response(SIMULATED_BODY, {
        status: SIMULATED_STATUS,
        headers: SIMULATED_HEADERS,
      });
    };
    const guardedFetch = createGuardedFetch({ fetchImpl, blockedHostnames });

    return async (url, options) => {
      try {
        return await guardedFetch(url, options);
      } catch (error) {
        this.#events.push({
          type: "fetch-blocked",
          request: {
            url: this.redact(url),
            method: requestMethod(options),
          },
          reason: this.redact(errorMessage(error)),
        });
        throw error;
      }
    };
  }

  recordCompile(decoded: DecodedPayload, payloadCharacters: number, hop: number): void {
    this.#events.push({
      type: "compile",
      hop,
      artifact: {
        payloadVersion: Number(decoded.version),
        payloadCharacters,
        interstitial: decoded.envelope.i === true,
        sealedSecrets: Object.keys(decoded.envelope.k ?? {}),
        compileClosures: decoded.envelope.c?.length ?? 0,
        notAfter: decoded.envelope.notAfter ?? null,
      },
    });
  }

  async success(response: Response, binary: boolean): Promise<SimulationReport> {
    const headers = this.#redactRecord(Object.fromEntries(response.headers));
    const body = binary
      ? { bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64") }
      : { body: this.redact(await response.text()) };
    return {
      simulated: true,
      inputs: this.#inputs,
      events: [...this.#events],
      response: { status: response.status, headers, ...body },
    };
  }

  failure(error: unknown): SimulationReport {
    return {
      simulated: true,
      inputs: this.#inputs,
      events: [...this.#events],
      error: this.redact(errorMessage(error)),
    };
  }
}
