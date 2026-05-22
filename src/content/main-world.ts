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
// Re-extraction request from the isolated-world bridge (#11). SPA
// navigation does not re-inject this script but YouTube updates
// `ytInitialPlayerResponse` for the new video, so we listen for the
// request and re-run extraction.
const REEXTRACT_REQUEST_TAG = "subflow:request-reextraction" as const;

function postExtraction(): void {
  if (window.location.pathname !== "/watch") return;
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

if (typeof window !== "undefined" && typeof window.postMessage === "function") {
  // Initial extraction at document_idle.
  postExtraction();

  // Listen for re-extraction requests posted by the isolated content
  // script on SPA navigation. Same-window, same-origin only.
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    if ((data as { type?: unknown }).type !== REEXTRACT_REQUEST_TAG) return;
    postExtraction();
  });
}
