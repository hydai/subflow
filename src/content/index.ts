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
// different video".
//
// `lastVideoId` persists ACROSS unmount events. Leaving /watch and
// later coming back to a different video is semantically the same as
// SPA-navigating from videoA → videoB: the background still needs a
// `subflow:video-changed` so SubtitleService.changeVideo can prune the
// old video's cache entries. Resetting on unmount would suppress that
// message and let stale cache accumulate across navigation cycles.
let lastVideoId: string | null = null;
let sidebarRoot: HTMLElement | null = null;

function syncSidebar(): void {
  const info = parseWatchPageUrl(window.location.href);
  if (info === null) {
    // Off the watch route — remove the sidebar but keep `lastVideoId`
    // so a return to /watch with a different id still triggers
    // video-changed.
    if (sidebarRoot !== null) {
      sidebarRoot.remove();
      sidebarRoot = null;
    }
    return;
  }

  if (sidebarRoot === null) {
    sidebarRoot = createSidebarRoot();
    document.body.appendChild(sidebarRoot);
  }

  if (info.videoId !== lastVideoId) {
    const isInitialObservation = lastVideoId === null;
    lastVideoId = info.videoId;

    if (!isInitialObservation) {
      // SPA navigation between two videos. Tell the background so
      // SubtitleService.changeVideo (#7) can prune cache entries
      // for the previous video and reset its playerData. We
      // deliberately skip this on the very FIRST observation in
      // the tab — at that point the freshly-extracted player data
      // arriving from the main-world script could be wiped by a
      // racing changeVideo if the two messages cross.
      void chrome.runtime.sendMessage({
        type: "subflow:video-changed",
        videoId: info.videoId,
      });

      // SPA navigation does NOT re-inject the main-world content
      // script, but ytInitialPlayerResponse on the page is updated
      // for the new video. Ask the main-world script (via the
      // same postMessage bridge it uses outbound) to re-read and
      // re-post for this new videoId.
      window.postMessage(
        { type: "subflow:request-reextraction" },
        window.location.origin,
      );
    }
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

// Browser-level fallback in case YouTube changes their event name.
// `popstate` covers back / forward navigation. We deliberately do NOT
// patch History.pushState or run a polling loop here — the
// `yt-navigate-finish` listener above already fires on every YouTube
// SPA transition (including ones triggered by pushState), so adding
// a polling fallback would be redundant noise.
window.addEventListener("popstate", syncSidebar);
