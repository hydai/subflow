// Subflow content script entry (isolated world).
//
// Two responsibilities live here:
//
//   1. Bridge specific `window.postMessage` envelopes from the
//      main-world script (#4) into chrome.runtime.sendMessage, since
//      the main world has no access to chrome.* APIs.
//
//   2. SPEC §6.4 sidebar lifecycle (#11): inject a Shadow-DOM-isolated
//      root element when the page is a YouTube watch URL, remove it
//      when the user navigates elsewhere, and on SPA navigation to a
//      different videoId notify the background so it can clean up
//      cache entries that no longer belong.
//
// content.js is loaded by Chrome as a classic script (the
// `content_scripts` entry in manifest.json does not set `"type":
// "module"`), so the emitted bundle must contain no ESM module syntax.
// We deliberately keep the file import-graph tiny so Rollup inlines
// everything into a single self-contained bundle: parseWatchPageUrl is
// the only consumer of @/lib/watch-page, so it's inlined; no message-
// tag constants are imported (the whitelist is duplicated inline and
// kept in sync by tests/content-bridge.test.ts).

import { parseWatchPageUrl } from "@/lib/watch-page";

const PLAYER_DATA_TAG = "subflow:player-data-extracted";
const SIDEBAR_ROOT_ID = "subflow-sidebar-root";

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

  if (candidate.type === PLAYER_DATA_TAG) {
    if (!isPlayerDataPayload(data)) return;
    const d = data as { href: string; result: unknown };
    void chrome.runtime.sendMessage({
      type: PLAYER_DATA_TAG,
      href: d.href,
      result: d.result,
    });
    return;
  }
});

// --------------------------------------------------------------------
// Sidebar lifecycle (#11)
// --------------------------------------------------------------------

// Module-scoped: survives `yt-navigate-finish` event fires so we can
// distinguish "first injection on this page" from "SPA-switched to a
// different video". Both `videoId` and the DOM root are tracked
// together since they always change in lock-step.
let currentVideoId: string | null = null;
let sidebarRoot: HTMLElement | null = null;

function syncSidebar(): void {
  const info = parseWatchPageUrl(window.location.href);
  if (info === null) {
    // Off the watch route — remove the sidebar entirely. The content
    // script keeps running because YouTube SPA navigation never
    // re-injects content scripts.
    if (sidebarRoot !== null) {
      sidebarRoot.remove();
      sidebarRoot = null;
    }
    currentVideoId = null;
    return;
  }

  if (sidebarRoot === null) {
    sidebarRoot = createSidebarRoot();
    document.body.appendChild(sidebarRoot);
    currentVideoId = info.videoId;
    return;
  }

  if (info.videoId !== currentVideoId) {
    // SPA navigated to a different video. Keep the sidebar but tell
    // the background to drop cache entries for the previous video
    // (SubtitleService.changeVideo from #7).
    currentVideoId = info.videoId;
    void chrome.runtime.sendMessage({
      type: "subflow:video-changed",
      videoId: info.videoId,
    });
  }
}

function createSidebarRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = SIDEBAR_ROOT_ID;
  // Shadow DOM keeps Subflow CSS isolated from YouTube's styles so the
  // sidebar can't accidentally affect (or be affected by) the host
  // page's layout (§6.4 "不污染 YouTube 頁面 layout").
  root.attachShadow({ mode: "open" });
  // Position the host fixed at the top-right corner — actual UI lands
  // in #12 once it has tests.
  root.style.position = "fixed";
  root.style.top = "0";
  root.style.right = "0";
  root.style.zIndex = "2147483647";
  return root;
}

// First sync at document_idle — manifest's `run_at` already covers
// "DOM ready", so the body element exists.
syncSidebar();

// YouTube emits this on every SPA navigation finish; observing it
// directly is much cheaper than polling.
document.addEventListener("yt-navigate-finish", syncSidebar);

// Browser-level fallback in case YouTube changes their event name. A
// `popstate` covers back/forward; we also poll the URL on each event
// to catch the cases that don't dispatch popstate (e.g. internal
// history.pushState followed by no further navigation event).
window.addEventListener("popstate", syncSidebar);

export {};
