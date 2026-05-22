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

function isSubflowMessage(value: unknown): value is Message {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return typeof candidate.type === "string" && candidate.type.startsWith("subflow:");
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isSubflowMessage(message)) return false;
  switch (message.type) {
    case "subflow:player-data-extracted":
      // TODO(#5): hand off to the caption-track selector. For now,
      // acknowledge so the content script's sendMessage promise
      // resolves cleanly.
      sendResponse({ ack: true });
      return false;
    default:
      return false;
  }
});
