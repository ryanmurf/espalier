import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core.ts",
    "src/relations.ts",
    "src/tenant-entry.ts",
    "src/observability-entry.ts",
    "src/graphql-entry.ts",
    "src/rest-entry.ts",
    "src/plugins-entry.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
});
