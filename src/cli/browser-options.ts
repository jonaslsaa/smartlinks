import { type Command, InvalidArgumentError, Option } from "commander";
import {
  type BrowserPolicy,
  type BrowserResourceField,
  type BrowserSource,
  browserSourceSchema,
  normalizeBrowserPolicy,
} from "../shared/browser-policy.js";

const BROWSER_CLI_RESOURCES = {
  scripts: {
    option: "allowScript",
    flag: "script",
    description: "allow external browser scripts",
  },
  connect: {
    option: "allowConnect",
    flag: "connect",
    description: "allow browser fetch/WebSocket access",
  },
  images: { option: "allowImage", flag: "image", description: "allow image loads" },
  styles: {
    option: "allowStyle",
    flag: "style",
    description: "allow external stylesheets",
  },
  fonts: { option: "allowFont", flag: "font", description: "allow font loads" },
  media: { option: "allowMedia", flag: "media", description: "allow audio and video loads" },
  frames: {
    option: "allowFrame",
    flag: "frame",
    description: "allow embedded documents",
  },
  forms: { option: "allowForm", flag: "form", description: "allow form submissions" },
  embeddableBy: {
    option: "allowEmbed",
    flag: "embed",
    description: "allow the source to embed the result",
  },
} as const satisfies Record<
  BrowserResourceField,
  { option: string; flag: string; description: string }
>;

type BrowserCliResource = (typeof BROWSER_CLI_RESOURCES)[BrowserResourceField];
type BrowserCliResourceOption = BrowserCliResource["option"];
const browserCliResourceEntries = Object.entries(BROWSER_CLI_RESOURCES) as [
  BrowserResourceField,
  BrowserCliResource,
][];

export type BrowserCliOptions = Record<BrowserCliResourceOption, BrowserSource[]> & {
  referrer?: "none" | "origin" | "full";
  cors?: boolean;
};

function collectBrowserSource(value: string, previous: BrowserSource[]): BrowserSource[] {
  const parsed = browserSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "Invalid browser source.");
  }
  return [...previous, parsed.data];
}

export function browserPolicyFromCli(options: BrowserCliOptions): BrowserPolicy | undefined {
  const resources: Partial<Record<BrowserResourceField, BrowserSource[]>> = {};
  for (const [field, resource] of browserCliResourceEntries) {
    resources[field] = options[resource.option];
  }
  return normalizeBrowserPolicy({
    ...resources,
    ...(options.referrer === undefined ? {} : { referrer: options.referrer }),
  });
}

export function addBrowserOptions(command: Command, interstitialConflicts = false): Command {
  const source = "source: self, https, all, or an exact HTTPS origin; repeatable";
  for (const [, resource] of browserCliResourceEntries) {
    const option = new Option(
      `--allow-${resource.flag} <source>`,
      `${resource.description}; ${source}`,
    )
      .argParser(collectBrowserSource)
      .default([]);
    if (resource.option === "allowEmbed" && interstitialConflicts) {
      option.conflicts(["interstitial", "interstitialNote"]);
    }
    command.addOption(option);
  }
  return command
    .addOption(
      new Option(
        "--referrer <level>",
        "referrer disclosure: none, origin, or full (full reveals the bearer URL)",
      ).choices(["none", "origin", "full"]),
    )
    .option("--cors", "allow credential-free cross-origin browser calls and preflight");
}
