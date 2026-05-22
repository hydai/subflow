// Subflow background service worker.
//
// Wires §6.8 entry point (a) (toolbar click → options page) and the
// inbound chrome.runtime.onMessage router. The router today only
// recognises the player-data-extracted envelope produced by the
// main-world / isolated content scripts (#4) and acknowledges it so
// the sender doesn't see a "Receiving end does not exist" warning.
// Subsequent issues (#5-#7, #15, #16, #18) plug subtitle reading,
// workflow execution, and error coverage into the same router.

import type { Message } from "@/lib/messages";

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Narrow the inbound value just enough to read its discriminator
// safely. We deliberately do NOT claim the value is a fully-typed
// Message here — per-variant validation happens at each case in the
// router below, so adding a new Message variant cannot accidentally
// inherit a permissive guard.
function hasSubflowType(value: unknown): value is { type: Message["type"] } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return typeof candidate.type === "string" && candidate.type.startsWith("subflow:");
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!hasSubflowType(message)) return false;
  switch (message.type) {
    case "subflow:player-data-extracted":
      // TODO(#5): hand off to the caption-track selector after
      // validating the `result` payload shape. For now, acknowledge so
      // the content script's sendMessage promise resolves cleanly.
      sendResponse({ ack: true });
      return false;
    default:
      return false;
  }
});
