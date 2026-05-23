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
  "subflow:request-reextraction",
  // Sidebar UI message contract (#12). Outbound from the content
  // script:
  "subflow:request-subtitle",
  "subflow:execute-workflow",
  "subflow:refetch-subtitle",
  // Inbound to the content script (background pushes):
  "subflow:subtitle-result",
  "subflow:workflow-result",
  // #17 — "Open settings" CTA relay (content can't call
  // openOptionsPage directly).
  "subflow:open-options-page",
]);

// The matched-quote regex below intentionally catches `subflow:*`
// tokens wrapped in any of double-quote, single-quote, or backtick.
// That includes tokens inside comments — comments in this codebase
// routinely describe tag names with markdown-style backticks (e.g.
// `subflow:video-changed`). The assertion treats both source-string
// and doc-string tag mentions the same way: anything that LOOKS
// like a tag literal must be in ALLOWED_CONTENT_TAGS. Comment
// mentions of allow-listed tags pass; comment mentions of an
// undocumented tag would fail just like a real string literal would.
// That extra strictness is the feature, not a bug.

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
  it("only mentions tags from the allowed set anywhere in src/content/index.ts (string literals and quoted-in-comments)", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/index.ts"), "utf8");
    // Match `subflow:*` ONLY when the token is wrapped in matching
    // quotes — `"…"`, `'…'`, or `` `…` ``. A line comment like
    // `// see subflow:foo` doesn't satisfy the quote-pair requirement
    // and is naturally excluded; the same goes for block comments
    // and identifier-like tokens. The cost: a tag appearing inside
    // documentation that itself uses matching quotes (e.g.
    // `// "subflow:foo"`) would falsely trigger — but the file's own
    // comments don't do that, so we accept the simple regex over a
    // TS-AST dependency.
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

  // The two classic-script entries each duplicate this tag inline
  // because importing a shared constant from @/lib/messages would
  // create a Rollup shared chunk (breaking the classic-script load).
  // Drift between the two copies would silently break SPA-driven
  // re-extraction, so we assert here that both sources mention the
  // exact same literal.
  it("keeps the request-reextraction tag in sync between content.ts and main-world.ts", () => {
    const expectedLiteral = `"subflow:request-reextraction"`;
    const contentSource = readFileSync(resolve(repoRoot, "src/content/index.ts"), "utf8");
    const mainWorldSource = readFileSync(resolve(repoRoot, "src/content/main-world.ts"), "utf8");
    expect(contentSource).toContain(expectedLiteral);
    expect(mainWorldSource).toContain(expectedLiteral);
  });

  // Classic-script entries (main-world.ts + content/index.ts) must
  // never share an `@/lib/*` import with ANY other build entry. The
  // moment two entries import the same module, Rollup emits a shared
  // chunk — and any ESM `import` statement in the emitted
  // \`content.js\` / \`content-main.js\` breaks the classic-script
  // load. With single-consumer imports, Rollup inlines.
  //
  // The check below walks the direct imports of each entry source
  // and asserts that no `@/lib/*` module is imported by both a
  // classic entry and any other entry. ESM-only entries
  // (background, sidebar, options) sharing an `@/lib/*` module
  // among themselves is fine — Rollup chunking is harmless there.
  it("does not share any direct @/lib import between a classic-script entry and any other entry", () => {
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
