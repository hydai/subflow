import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PLAYER_DATA_POSTMESSAGE_TAG } from "@/lib/messages";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

describe("content-script bridge wiring (SPEC §6.1.1, #4)", () => {
  // The isolated-world bridge whitelists which postMessage tags it
  // will forward. Any page-world script can call window.postMessage,
  // so widening the bridge to forward arbitrary `subflow:*` envelopes
  // would let unrelated page scripts spam the background. Keep the
  // whitelist exact.
  it("whitelists only the canonical player-data postMessage tag in content.ts", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/index.ts"), "utf8");
    expect(source).toContain(`"${PLAYER_DATA_POSTMESSAGE_TAG}"`);
  });

  // The main-world content script deliberately inlines the postMessage
  // tag (instead of importing from messages.ts) so Rollup doesn't emit
  // a shared chunk that would break the classic-script load. This
  // test catches drift between the canonical constant and the inlined
  // copy.
  it("keeps main-world.ts's inlined postMessage tag in sync with PLAYER_DATA_POSTMESSAGE_TAG", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/main-world.ts"), "utf8");
    expect(source).toContain(`"${PLAYER_DATA_POSTMESSAGE_TAG}"`);
  });

  // content.ts is the isolated-world bridge. It must stay free of
  // module-level imports from `@/lib/*` so the classic-script bundle
  // doesn't pull in a shared chunk. The forwarding logic relies on
  // an inline whitelist (asserted by the test above) rather than on
  // imported tag constants, so no `@/lib/*` runtime imports should
  // appear here.
  it("keeps the isolated content script free of @/lib imports", () => {
    const source = readFileSync(resolve(repoRoot, "src/content/index.ts"), "utf8");
    expect(source).not.toMatch(/^import .* from "@\//m);
  });
});
