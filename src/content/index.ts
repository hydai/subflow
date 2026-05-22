// Subflow content script entry (isolated world).
// Real behavior is delivered by later issues (e.g. #11, #12).
//
// content.js is loaded by Chrome as a classic script (the
// `content_scripts` entry in manifest.json does not set `"type":
// "module"`), so the emitted bundle must contain no ESM module syntax
// — neither `import` nor `export`. Today this script's only job is to
// bridge specific `window.postMessage` envelopes from the main-world
// content script (#4) into chrome.runtime.sendMessage, since the main
// world has no access to chrome.* APIs.
//
// To keep the bundle import-free we deliberately do NOT import shared
// constants from `@/lib/messages` here: doing so would force Rollup
// to emit a shared chunk that the classic content script could not
// load. The expected postMessage tags are hardcoded below; the test
// in `tests/content-bridge.test.ts` keeps them in sync with the
// canonical constants in `src/lib/messages.ts`. Any page-world script
// can call `window.postMessage`, so the whitelist keeps the bridge
// narrow — only known tags get forwarded; everything else is dropped.

// The bare `export {}` below switches TypeScript from "script" mode
// to "module" mode for this file, so `ALLOWED_TAGS` stays
// file-local rather than entering the global TS scope. Rollup strips
// the empty re-export from the emitted bundle (no semantic effect),
// so the classic-script load is unaffected.
const PLAYER_DATA_TAG = "subflow:player-data-extracted";

// Minimal shape check for each allowed tag. Any page-world script can
// call window.postMessage with a valid tag, so forwarding the raw
// payload through to chrome.runtime would let a hostile page DoS the
// background or inject garbage result shapes. Each tag has a small
// inline validator that the bridge consults before forwarding.
function isPlayerDataPayload(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== PLAYER_DATA_TAG) return false;
  if (typeof v.href !== "string") return false;
  const result = v.result;
  if (result === null || typeof result !== "object") return false;
  return typeof (result as { ok?: unknown }).ok === "boolean";
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (data === null || typeof data !== "object") return;
  const candidate = data as { type?: unknown };
  if (typeof candidate.type !== "string") return;

  // Each allowed tag has its own minimal validator. Adding a new tag
  // here requires adding both the tag and a validator branch, which
  // forces a deliberate code review.
  if (candidate.type === PLAYER_DATA_TAG) {
    if (!isPlayerDataPayload(data)) return;
    void chrome.runtime.sendMessage(data);
    return;
  }
});

export {};
