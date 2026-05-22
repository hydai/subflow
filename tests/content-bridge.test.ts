import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PLAYER_DATA_POSTMESSAGE_TAG } from "@/lib/messages";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Tags that the isolated content script (`src/content/index.ts`) is
// allowed to mention as string literals. Adding a new outbound or
// inbound tag REQUIRES updating this list and explaining the reason
// at the call site.
const ALLOWED_CONTENT_TAGS = new Set([
  PLAYER_DATA_POSTMESSAGE_TAG,
  "subflow:video-changed",
]);

function extractImportsOf(file: string): Set<string> {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const imports = new Set<string>();
  const importRe = /^import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of source.matchAll(importRe)) {
    imports.add(m[1]!);
  }
  return imports;
}

describe("content-script bridge wiring (SPEC §6.1.1, #4 + §6.4, #11)", () => {
  it("only mentions tags from the allowed set in src/content/index.ts", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/index.ts"), "utf8");
    const literals = source.match(/"subflow:[^"]*"/g) ?? [];
    const used = new Set(literals.map((s) => s.slice(1, -1)));
    for (const tag of used) {
      expect(ALLOWED_CONTENT_TAGS.has(tag)).toBe(true);
    }
    // And the canonical player-data tag must be present — the bridge
    // would be useless without it.
    expect(used.has(PLAYER_DATA_POSTMESSAGE_TAG)).toBe(true);
  });

  it("keeps main-world.ts's inlined postMessage tag in sync with PLAYER_DATA_POSTMESSAGE_TAG", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/main-world.ts"), "utf8");
    expect(source).toContain(`"${PLAYER_DATA_POSTMESSAGE_TAG}"`);
  });

  // Classic-script entries (main-world.ts + content/index.ts) must
  // never import the SAME `@/lib/*` module: Rollup would then emit a
  // shared chunk, breaking the classic-script load. Each entry may
  // import from `@/lib/*` only when it is the SOLE consumer of that
  // module — Rollup inlines a single-consumer import.
  it("does not share any @/lib import between the two classic-script entries", () => {
    const mainWorldImports = new Set(
      [...extractImportsOf("src/content/main-world.ts")].filter((s) => s.startsWith("@/lib/")),
    );
    const contentImports = new Set(
      [...extractImportsOf("src/content/index.ts")].filter((s) => s.startsWith("@/lib/")),
    );
    const shared: string[] = [];
    for (const m of mainWorldImports) {
      if (contentImports.has(m)) shared.push(m);
    }
    expect(shared).toEqual([]);
  });
});
