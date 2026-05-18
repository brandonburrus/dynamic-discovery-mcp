import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  banner: ctx => (ctx.format === "esm" ? { js: "#!/usr/bin/env node" } : {}),
});
