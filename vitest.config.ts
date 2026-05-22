import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

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
      "@": resolve(here, "src"),
    },
  },
});
