import { describe, expect, it } from "vitest";
import {
  type ArtifactBrowserSettings,
  browserSettingsFromWire,
  browserSettingsToWire,
  guestContentSecurityPolicy,
  normalizeBrowserPolicy,
  referrerPolicy,
} from "../../src/shared/browser-policy.js";

describe("browser policy", () => {
  it("normalizes exact origins and removes sources already covered by broader grants", () => {
    expect(
      normalizeBrowserPolicy({
        scripts: ["https://cdn.example", "https", "self", "https://cdn.example"],
        images: ["all", "https://images.example"],
        referrer: "none",
      }),
    ).toEqual({ scripts: ["https", "self"], images: ["all"] });

    for (const source of [
      "http://cdn.example",
      "https://cdn.example/path",
      "https://user@cdn.example",
    ]) {
      expect(() => normalizeBrowserPolicy({ scripts: [source] })).toThrow("exact HTTPS origins");
    }
  });

  it("round-trips a compact wire representation without semantic field names", () => {
    const settings: ArtifactBrowserSettings = {
      browser: {
        scripts: ["https://cdn.example", "self"],
        connect: ["https"],
        images: ["all"],
        styles: ["https://styles.example"],
        fonts: ["https://fonts.example"],
        media: ["https://media.example"],
        frames: ["https://frames.example"],
        forms: ["https://forms.example"],
        embeddableBy: ["all"],
        referrer: "full" as const,
      },
      cors: true as const,
    };
    const wire = browserSettingsToWire(settings);

    expect(wire).toEqual({
      s: ["@cdn.example", "s"],
      c: ["h"],
      i: ["*"],
      y: ["@styles.example"],
      f: ["@fonts.example"],
      m: ["@media.example"],
      r: ["@frames.example"],
      a: ["@forms.example"],
      e: ["*"],
      p: "f",
      x: true,
    });
    expect(JSON.stringify(wire)).not.toMatch(/scripts|connect|embeddable|referrer|cors/u);
    expect(browserSettingsFromWire(wire)).toEqual(settings);
  });

  it("builds an opaque-origin sandbox with useful local defaults and explicit external grants", () => {
    const policy = guestContentSecurityPolicy(
      {
        scripts: ["self", "https://cdn.example"],
        connect: ["self", "https://api.example"],
        embeddableBy: ["https://host.example"],
      },
      "https://s.example",
    );

    expect(policy).toContain("sandbox allow-downloads");
    expect(policy).toContain("allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain(
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.example https://s.example",
    );
    expect(policy).toContain("worker-src data: blob: https://cdn.example https://s.example");
    expect(policy).toContain("img-src data: blob:");
    expect(policy).toContain(
      "connect-src https://api.example https://s.example wss://api.example wss://s.example",
    );
    expect(guestContentSecurityPolicy({ connect: ["https"] }, "https://s.example")).toContain(
      "connect-src https: wss:",
    );
    expect(policy).toContain("form-action https://s.example");
    expect(policy).toContain("frame-ancestors https://host.example");
  });

  it("keeps disclosure off unless the artifact opts in", () => {
    expect(referrerPolicy(undefined)).toBe("no-referrer");
    expect(referrerPolicy({ referrer: "origin" })).toBe("origin");
    expect(referrerPolicy({ referrer: "full" })).toBe("unsafe-url");
  });

  it("omits frame-ancestors only when embedding is open to opaque origins", () => {
    expect(
      guestContentSecurityPolicy({ embeddableBy: ["all"] }, "https://s.example"),
    ).not.toContain("frame-ancestors");
    expect(guestContentSecurityPolicy(undefined, "https://s.example")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
