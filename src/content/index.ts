// Subflow content script entry (isolated world).
// Real behavior is delivered by later issues (e.g. #11, #12).
//
// content.js is loaded by Chrome as a classic script (the
// `content_scripts` entry in manifest.json does not set `"type":
// "module"`), so the emitted bundle must contain no ESM module syntax
// — neither `import` nor `export`. Today this script's only job is to
// bridge `window.postMessage` traffic from the main-world content
// script (#4) into chrome.runtime.sendMessage, since the main world
// has no access to chrome.* APIs.
//
// To keep the bundle import-free we deliberately do NOT import shared
// constants from `@/lib/messages` here: doing so would force Rollup
// to emit a shared chunk that the classic content script could not
// load. The forwarder is generic — it relays any postMessage whose
// `type` starts with the `subflow:` prefix and lets the background
// service worker do the typed parsing — so this file never needs to
// know about specific message tags.

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (data === null || typeof data !== "object") return;
  const candidate = data as { type?: unknown };
  if (typeof candidate.type !== "string" || !candidate.type.startsWith("subflow:")) return;
  void chrome.runtime.sendMessage(data);
});
