import { z } from "zod";

export const MAX_BROWSER_SOURCES = 16;

export type BrowserSource = "self" | "https" | "all" | `https://${string}`;
export type ReferrerDisclosure = "none" | "origin" | "full";

export type BrowserPolicy = {
  scripts?: BrowserSource[];
  connect?: BrowserSource[];
  images?: BrowserSource[];
  styles?: BrowserSource[];
  fonts?: BrowserSource[];
  media?: BrowserSource[];
  frames?: BrowserSource[];
  forms?: BrowserSource[];
  embeddableBy?: BrowserSource[];
  referrer?: ReferrerDisclosure;
};

export type ArtifactBrowserSettings = {
  browser?: BrowserPolicy;
  cors?: true;
};

function normalizeSource(value: string, context: z.RefinementCtx): BrowserSource {
  if (value === "self" || value === "https" || value === "all") {
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: 'Expected "self", "https", "all", or an exact HTTPS origin.',
    });
    return z.NEVER;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    context.addIssue({
      code: "custom",
      message: "Browser sources must be exact HTTPS origins without paths or credentials.",
    });
    return z.NEVER;
  }
  return url.origin as `https://${string}`;
}

export const browserSourceSchema = z.string().min(1).max(255).transform(normalizeSource);

function canonicalSources(sources: BrowserSource[]): BrowserSource[] {
  const unique = [...new Set(sources)];
  if (unique.includes("all")) {
    return ["all"];
  }
  const useful = unique.includes("https")
    ? unique.filter((source) => source === "self" || source === "https")
    : unique;
  return useful.sort();
}

const browserSourcesSchema = z
  .array(browserSourceSchema)
  .max(MAX_BROWSER_SOURCES)
  .transform(canonicalSources);

const browserPolicyObjectSchema = z
  .object({
    scripts: browserSourcesSchema.optional(),
    connect: browserSourcesSchema.optional(),
    images: browserSourcesSchema.optional(),
    styles: browserSourcesSchema.optional(),
    fonts: browserSourcesSchema.optional(),
    media: browserSourcesSchema.optional(),
    frames: browserSourcesSchema.optional(),
    forms: browserSourcesSchema.optional(),
    embeddableBy: browserSourcesSchema.optional(),
    referrer: z.enum(["none", "origin", "full"]).optional(),
  })
  .strict();

function compactPolicy(
  policy: z.infer<typeof browserPolicyObjectSchema>,
): BrowserPolicy | undefined {
  const compact = Object.fromEntries(
    Object.entries(policy).filter(
      ([name, value]) =>
        value !== undefined &&
        !(Array.isArray(value) && value.length === 0) &&
        !(name === "referrer" && value === "none"),
    ),
  ) as BrowserPolicy;
  return Object.keys(compact).length === 0 ? undefined : compact;
}

export const browserPolicySchema = browserPolicyObjectSchema.transform(compactPolicy);

export function normalizeBrowserPolicy(input: unknown): BrowserPolicy | undefined {
  return input === undefined ? undefined : browserPolicySchema.parse(input);
}

const wireSourceSchema = z.string().min(1).max(255);
const wireSourcesSchema = z.array(wireSourceSchema).min(1).max(MAX_BROWSER_SOURCES);

export const wireBrowserSettingsSchema = z
  .object({
    s: wireSourcesSchema.optional(),
    c: wireSourcesSchema.optional(),
    i: wireSourcesSchema.optional(),
    y: wireSourcesSchema.optional(),
    f: wireSourcesSchema.optional(),
    m: wireSourcesSchema.optional(),
    r: wireSourcesSchema.optional(),
    a: wireSourcesSchema.optional(),
    e: wireSourcesSchema.optional(),
    p: z.union([z.literal("o"), z.literal("f")]).optional(),
    x: z.literal(true).optional(),
  })
  .strict();

export type WireBrowserSettings = z.infer<typeof wireBrowserSettingsSchema>;

function sourceToWire(source: BrowserSource): string {
  if (source === "self") return "s";
  if (source === "https") return "h";
  if (source === "all") return "*";
  return `@${source.slice("https://".length)}`;
}

function sourceFromWire(source: string): BrowserSource {
  if (source === "s") return "self";
  if (source === "h") return "https";
  if (source === "*") return "all";
  if (source.startsWith("@")) {
    return browserSourceSchema.parse(`https://${source.slice(1)}`);
  }
  throw new Error("The browser policy contains an invalid source.");
}

function sourcesToWire(sources: BrowserSource[] | undefined): string[] | undefined {
  return sources?.length ? sources.map(sourceToWire) : undefined;
}

function sourcesFromWire(sources: string[] | undefined): BrowserSource[] | undefined {
  return sources?.map(sourceFromWire);
}

export function browserSettingsToWire(
  settings: ArtifactBrowserSettings,
): WireBrowserSettings | undefined {
  const policy = normalizeBrowserPolicy(settings.browser);
  const scripts = sourcesToWire(policy?.scripts);
  const connect = sourcesToWire(policy?.connect);
  const images = sourcesToWire(policy?.images);
  const styles = sourcesToWire(policy?.styles);
  const fonts = sourcesToWire(policy?.fonts);
  const media = sourcesToWire(policy?.media);
  const frames = sourcesToWire(policy?.frames);
  const forms = sourcesToWire(policy?.forms);
  const embeddableBy = sourcesToWire(policy?.embeddableBy);
  const wire = {
    ...(scripts ? { s: scripts } : {}),
    ...(connect ? { c: connect } : {}),
    ...(images ? { i: images } : {}),
    ...(styles ? { y: styles } : {}),
    ...(fonts ? { f: fonts } : {}),
    ...(media ? { m: media } : {}),
    ...(frames ? { r: frames } : {}),
    ...(forms ? { a: forms } : {}),
    ...(embeddableBy ? { e: embeddableBy } : {}),
    ...(policy?.referrer === "origin"
      ? { p: "o" as const }
      : policy?.referrer === "full"
        ? { p: "f" as const }
        : {}),
    ...(settings.cors === true ? { x: true as const } : {}),
  };
  return Object.keys(wire).length === 0 ? undefined : wireBrowserSettingsSchema.parse(wire);
}

export function browserSettingsFromWire(
  wire: WireBrowserSettings | undefined,
): ArtifactBrowserSettings {
  if (wire === undefined) {
    return {};
  }
  const parsed = wireBrowserSettingsSchema.parse(wire);
  const scripts = sourcesFromWire(parsed.s);
  const connect = sourcesFromWire(parsed.c);
  const images = sourcesFromWire(parsed.i);
  const styles = sourcesFromWire(parsed.y);
  const fonts = sourcesFromWire(parsed.f);
  const media = sourcesFromWire(parsed.m);
  const frames = sourcesFromWire(parsed.r);
  const forms = sourcesFromWire(parsed.a);
  const embeddableBy = sourcesFromWire(parsed.e);
  const browser = normalizeBrowserPolicy({
    ...(scripts ? { scripts } : {}),
    ...(connect ? { connect } : {}),
    ...(images ? { images } : {}),
    ...(styles ? { styles } : {}),
    ...(fonts ? { fonts } : {}),
    ...(media ? { media } : {}),
    ...(frames ? { frames } : {}),
    ...(forms ? { forms } : {}),
    ...(embeddableBy ? { embeddableBy } : {}),
    ...(parsed.p === "o" ? { referrer: "origin" as const } : {}),
    ...(parsed.p === "f" ? { referrer: "full" as const } : {}),
  });
  return {
    ...(browser ? { browser } : {}),
    ...(parsed.x === true ? { cors: true as const } : {}),
  };
}

export function browserSettingsIdentity(settings: ArtifactBrowserSettings): readonly unknown[] {
  const browser = normalizeBrowserPolicy(settings.browser);
  return browser === undefined && settings.cors !== true
    ? []
    : [["browser-v1", browser ?? null, settings.cors === true]];
}

function cspSources(sources: BrowserSource[] | undefined, runtimeOrigin: string): string[] {
  if (!sources?.length) {
    return [];
  }
  if (sources.includes("all")) {
    return ["*"];
  }
  return sources.map((source) => {
    if (source === "self") return runtimeOrigin;
    if (source === "https") return "https:";
    return source;
  });
}

function connectCspSources(sources: BrowserSource[] | undefined, runtimeOrigin: string): string[] {
  const networkSources = cspSources(sources, runtimeOrigin);
  if (!sources?.length || sources.includes("all")) {
    return networkSources;
  }
  const websocketSources = sources.map((source) => {
    if (source === "self") {
      return runtimeOrigin.replace(/^http/u, "ws");
    }
    if (source === "https") {
      return "wss:";
    }
    return source.replace(/^https:/u, "wss:");
  });
  return [...new Set([...networkSources, ...websocketSources])];
}

function directive(name: string, defaults: string[], sources: string[]): string {
  const values = [...new Set([...defaults, ...sources])];
  return `${name} ${values.length ? values.join(" ") : "'none'"}`;
}

const SANDBOX_PERMISSIONS = [
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-scripts",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
] as const;

export function guestContentSecurityPolicy(
  browser: BrowserPolicy | undefined,
  service: string,
): string {
  const policy = normalizeBrowserPolicy(browser);
  const runtimeOrigin = new URL(service).origin;
  const scripts = cspSources(policy?.scripts, runtimeOrigin);
  const frames = cspSources(policy?.frames, runtimeOrigin);
  const ancestors = cspSources(policy?.embeddableBy, runtimeOrigin);
  const forms = cspSources(policy?.forms, runtimeOrigin);
  // A sandboxed Smartlink has an opaque ancestor origin, which no CSP source expression can
  // match. Omitting frame-ancestors is therefore the only faithful representation of `all`.
  const frameAncestors = policy?.embeddableBy?.includes("all")
    ? []
    : [directive("frame-ancestors", [], ancestors)];
  return [
    "default-src 'none'",
    `sandbox ${SANDBOX_PERMISSIONS.join(" ")}`,
    directive(
      "script-src",
      ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:"],
      scripts,
    ),
    directive("worker-src", ["data:", "blob:"], scripts),
    directive("style-src", ["'unsafe-inline'"], cspSources(policy?.styles, runtimeOrigin)),
    directive("img-src", ["data:", "blob:"], cspSources(policy?.images, runtimeOrigin)),
    directive("font-src", ["data:", "blob:"], cspSources(policy?.fonts, runtimeOrigin)),
    directive("media-src", ["data:", "blob:"], cspSources(policy?.media, runtimeOrigin)),
    directive("connect-src", [], connectCspSources(policy?.connect, runtimeOrigin)),
    directive("frame-src", [], frames),
    directive("object-src", [], frames),
    directive("form-action", [runtimeOrigin], forms),
    ...frameAncestors,
  ].join("; ");
}

export function referrerPolicy(browser: BrowserPolicy | undefined): string {
  const disclosure = normalizeBrowserPolicy(browser)?.referrer;
  if (disclosure === "origin") return "origin";
  if (disclosure === "full") return "unsafe-url";
  return "no-referrer";
}

export function isEmbeddable(browser: BrowserPolicy | undefined): boolean {
  return (normalizeBrowserPolicy(browser)?.embeddableBy?.length ?? 0) > 0;
}
