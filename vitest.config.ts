import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Coverage is intentionally not configured here: enabling it would
// require a coverage provider package (e.g. `@vitest/coverage-v8`),
// which is not yet a dependency. The first issue that adds coverage
// reporting can wire the provider and config together.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
