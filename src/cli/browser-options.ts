import { type Command, InvalidArgumentError, Option } from "commander";
import {
  type BrowserPolicy,
  type BrowserSource,
  browserSourceSchema,
  normalizeBrowserPolicy,
} from "../shared/browser-policy.js";

export type BrowserCliOptions = {
  allowScript: BrowserSource[];
  allowConnect: BrowserSource[];
  allowImage: BrowserSource[];
  allowStyle: BrowserSource[];
  allowFont: BrowserSource[];
  allowMedia: BrowserSource[];
  allowFrame: BrowserSource[];
  allowForm: BrowserSource[];
  allowEmbed: BrowserSource[];
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
  return normalizeBrowserPolicy({
    scripts: options.allowScript,
    connect: options.allowConnect,
    images: options.allowImage,
    styles: options.allowStyle,
    fonts: options.allowFont,
    media: options.allowMedia,
    frames: options.allowFrame,
    forms: options.allowForm,
    embeddableBy: options.allowEmbed,
    ...(options.referrer === undefined ? {} : { referrer: options.referrer }),
  });
}

export function addBrowserOptions(command: Command, interstitialConflicts = false): Command {
  const source = "source: self, https, all, or an exact HTTPS origin; repeatable";
  const embed = new Option(
    "--allow-embed <source>",
    `allow the source to embed the result; ${source}`,
  )
    .argParser(collectBrowserSource)
    .default([]);
  if (interstitialConflicts) {
    embed.conflicts(["interstitial", "interstitialNote"]);
  }
  return command
    .addOption(
      new Option("--allow-script <source>", `allow external browser scripts; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-connect <source>", `allow browser fetch/WebSocket access; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-image <source>", `allow image loads; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-style <source>", `allow external stylesheets; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-font <source>", `allow font loads; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-media <source>", `allow audio and video loads; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-frame <source>", `allow embedded documents; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(
      new Option("--allow-form <source>", `allow form submissions; ${source}`)
        .argParser(collectBrowserSource)
        .default([]),
    )
    .addOption(embed)
    .addOption(
      new Option(
        "--referrer <level>",
        "referrer disclosure: none, origin, or full (full reveals the bearer URL)",
      ).choices(["none", "origin", "full"]),
    )
    .option("--cors", "allow credential-free cross-origin browser calls and preflight");
}
