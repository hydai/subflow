// Main-world content script. Runs in the YouTube page's own JS
// context so it can read `window.ytInitialPlayerResponse`, then hands
// the extraction result to the isolated-world content script via
// `window.postMessage`. The isolated script forwards over
// chrome.runtime.sendMessage; the main world has no access to
// chrome.* APIs.
//
// MV3 caveat (vite.config.ts): main-world content scripts are loaded
// as classic scripts. The emitted bundle must contain no ESM
// `import` / `export` syntax. Rollup inlines whatever this module
// imports, so importing `extractPlayerData` from src/lib/extract is
// safe as long as no other extension entry also imports from there —
// the first entry that does will turn it into a shared chunk and
// break this script. Today main-world is the sole consumer; the
// per-entry Vite invocation refactor noted in vite.config.ts will be
// needed when that ceases to be true.

import { extractPlayerData } from "@/lib/extract";

declare global {
  interface Window {
    ytInitialPlayerResponse?: unknown;
  }
}

// Mirrors `PLAYER_DATA_POSTMESSAGE_TAG` from src/lib/messages.ts.
// Inlined here rather than imported so this script does not pull
// from any module that other extension entries also import — that
// would force Rollup to emit a shared chunk and break the classic-
// script load. Tests assert the two stay in sync.
const POST_MESSAGE_TAG = "subflow:player-data-extracted" as const;

if (typeof window !== "undefined" && typeof window.postMessage === "function") {
  const result = extractPlayerData(window.ytInitialPlayerResponse);
  window.postMessage(
    {
      type: POST_MESSAGE_TAG,
      href: window.location.href,
      result,
    },
    window.location.origin,
  );
}
