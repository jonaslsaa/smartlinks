import * as p from "@clack/prompts";

export function startUi(title: string, json: boolean): boolean {
  const interactive = process.stdout.isTTY && !json;
  if (interactive) {
    p.intro(title);
  }
  return interactive;
}

export function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error.";
  console.error(`Error: ${message}`);
}
