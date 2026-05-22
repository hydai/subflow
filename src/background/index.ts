// Subflow background service worker.
//
// Wires §6.8 entry point (a) (toolbar click → options page) and the
// inbound chrome.runtime.onMessage router. The router today only
// recognises the player-data-extracted envelope produced by the
// main-world / isolated content scripts (#4) and acknowledges it so
// the sender doesn't see a "Receiving end does not exist" warning.
// Subsequent issues (#5-#7, #15, #16, #18) plug subtitle reading,
// workflow execution, and error coverage into the same router.

import { PLAYER_DATA_POSTMESSAGE_TAG } from "@/lib/messages";

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Narrow the inbound value just enough to read its discriminator
// safely. The runtime only verifies the `subflow:` prefix, so the
// narrowing target uses a template-literal type that matches exactly
// what was checked — not the `Message["type"]` union of known
// literals, which would be claiming more than the runtime proves.
// Per-variant validation happens at each case in the router below.
function hasSubflowType(value: unknown): value is { type: `subflow:${string}` } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return typeof candidate.type === "string" && candidate.type.startsWith("subflow:");
}

// Sender guard: messages coming through the content-script bridge
// originate from a YouTube tab. Reject anything posted from other
// extension contexts (e.g. the options page) or from tabs on other
// origins so a compromised / hostile non-YouTube context cannot drive
// the subtitle / workflow pipelines via forged messages.
function isFromYouTubeTab(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.tab?.url;
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://www.youtube.com";
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!hasSubflowType(message)) return false;
  if (!isFromYouTubeTab(sender)) return false;
  switch (message.type) {
    case PLAYER_DATA_POSTMESSAGE_TAG:
      // TODO(#5): hand off to the caption-track selector after
      // validating the `result` payload shape. For now, acknowledge so
      // the content script's sendMessage promise resolves cleanly.
      sendResponse({ ack: true });
      return false;
    default:
      return false;
  }
});
