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

// Direct runtime imports only — `import type { … }` lines are
// erased by the TS compiler before Rollup ever sees them, so they
// can't cause a shared chunk and should NOT count toward the
// classic-script overlap check below.
function extractImportsOf(file: string): Set<string> {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const imports = new Set<string>();
  const importRe = /^import\s+(?!type\s)(?:[^"']+\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of source.matchAll(importRe)) {
    imports.add(m[1]!);
  }
  return imports;
}

describe("content-script bridge wiring (SPEC §6.1.1, #4 + §6.4, #11)", () => {
  it("only mentions tags from the allowed set in src/content/index.ts string literals", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/index.ts"), "utf8");
    // Match `subflow:*` ONLY inside a string literal — double-quoted,
    // single-quoted, or backtick-templated. Comments and identifiers
    // are deliberately excluded so this test enforces "what gets
    // emitted at runtime" rather than "what appears in source text".
    const stringRe = /(["'`])(subflow:[a-zA-Z0-9_-]+)\1/g;
    const used = new Set<string>();
    for (const m of source.matchAll(stringRe)) used.add(m[2]!);
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
  // never share an `@/lib/*` import with ANY other build entry. The
  // moment two entries import the same module, Rollup emits a shared
  // chunk — and any ESM `import` statement in the emitted
  // \`content.js\` / \`content-main.js\` breaks the classic-script
  // load. With single-consumer imports, Rollup inlines.
  //
  // The check below walks the direct imports of each entry source
  // and asserts that every `@/lib/*` module that a classic entry
  // pulls in is unique across the whole build.
  it("does not share any direct @/lib import between any two build entries", () => {
    const entrySources = [
      "src/background/index.ts",
      "src/content/index.ts",
      "src/content/main-world.ts",
      "src/sidebar/index.ts",
      "src/options/index.ts",
    ];
    const classicEntries = new Set(["src/content/index.ts", "src/content/main-world.ts"]);

    // Map<module, entries that import it>
    const importersOf = new Map<string, string[]>();
    for (const entry of entrySources) {
      const libImports = [...extractImportsOf(entry)].filter((s) => s.startsWith("@/lib/"));
      for (const mod of libImports) {
        const list = importersOf.get(mod) ?? [];
        list.push(entry);
        importersOf.set(mod, list);
      }
    }

    const conflicts: Array<{ module: string; importers: string[] }> = [];
    for (const [mod, importers] of importersOf) {
      const touchesClassic = importers.some((e) => classicEntries.has(e));
      if (touchesClassic && importers.length > 1) {
        conflicts.push({ module: mod, importers });
      }
    }
    expect(conflicts).toEqual([]);
  });
});
