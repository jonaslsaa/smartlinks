import { defineConfig } from "tsup";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node24",
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  define: { __SMARTLINKS_VERSION__: JSON.stringify(packageJson.version) },
});
