// Subflow background service worker.
//
// Wires §6.8 entry point (a) (toolbar click → options page) and the
// inbound chrome.runtime.onMessage router. The router accepts the
// post-bridged player-data envelope from the main-world / isolated
// content scripts (#4), the subtitle-request flow described by
// SPEC §6.1 + §6.2 + §6.7 (#7), and the SPA-navigation /
// manual-refresh cleanups owned by the same SubtitleService.
//
// Per-tab state and the cache / dedup / fetch plumbing live in
// `./subtitle-service.ts`; this file only translates chrome messages
// into service calls.

import { PLAYER_DATA_POSTMESSAGE_TAG } from "@/lib/messages";
import { fetchSubtitleXml } from "./fetch-subtitle";
import { SubtitleService } from "./subtitle-service";
import type { PlayerDataState } from "./subtitle-service";

const subtitles = new SubtitleService({ fetchSubtitleXml });

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Drop the tab's entire SubtitleService state on close so the
// in-memory cache cannot outlive the tab it was scoped to (§6.2).
chrome.tabs.onRemoved.addListener((tabId) => {
  subtitles.invalidateTab(tabId);
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
// origins so a compromised / hostile non-YouTube context cannot
// drive the subtitle / workflow pipelines via forged messages.
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

interface PlayerDataPayload {
  type: typeof PLAYER_DATA_POSTMESSAGE_TAG;
  href: string;
  result: PlayerDataState;
}

interface RequestSubtitlePayload {
  type: "subflow:request-subtitle";
  videoId: string;
  languagePriority: string[];
}

interface RefetchSubtitlePayload {
  type: "subflow:refetch-subtitle";
  videoId: string;
}

interface VideoChangedPayload {
  type: "subflow:video-changed";
  videoId: string;
}

function isPlayerDataPayload(value: unknown): value is PlayerDataPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== PLAYER_DATA_POSTMESSAGE_TAG) return false;
  if (typeof v.href !== "string") return false;
  const result = v.result;
  if (result === null || typeof result !== "object") return false;
  const ok = (result as { ok?: unknown }).ok;
  if (typeof ok !== "boolean") return false;
  if (ok === false) {
    const error = (result as { error?: unknown }).error;
    if (error === null || typeof error !== "object") return false;
    const errType = (error as { type?: unknown }).type;
    // Restrict to the known ExtractError variants so extractErrorToStatus
    // in the service never receives an unknown literal.
    if (errType !== "MISSING_PLAYER_RESPONSE" && errType !== "MALFORMED_PLAYER_RESPONSE") {
      return false;
    }
    if (errType === "MALFORMED_PLAYER_RESPONSE") {
      return typeof (error as { reason?: unknown }).reason === "string";
    }
    return true;
  }
  // ok === true: the data side must look like ExtractedPlayerData
  // enough that the service won't crash downstream. We validate every
  // field selectTrack / parseTimedText / the §6.6 precondition checks
  // actually read.
  const data = (result as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const tracks = d.captionTracks;
  if (!Array.isArray(tracks)) return false;
  if (!tracks.every(isCaptionTrack)) return false;
  const vd = d.videoDetails;
  if (vd === null || typeof vd !== "object") return false;
  const details = vd as Record<string, unknown>;
  if (typeof details.videoId !== "string" || details.videoId.length === 0) return false;
  if (typeof details.isLive !== "boolean") return false;
  if (typeof details.isUpcoming !== "boolean") return false;
  if (details.lengthSeconds !== undefined && typeof details.lengthSeconds !== "number") {
    return false;
  }
  return true;
}

function isCaptionTrack(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  if (typeof t.baseUrl !== "string") return false;
  if (typeof t.languageCode !== "string") return false;
  if (typeof t.isTranslatable !== "boolean") return false;
  // `kind` is either the literal "asr" or omitted entirely.
  if (t.kind !== undefined && t.kind !== "asr") return false;
  return true;
}

function isFromSameHrefOrigin(href: string, sender: chrome.runtime.MessageSender): boolean {
  // Stale extraction results from a previously-loaded page can race
  // with a fresh sender-tab URL; require that the `href` the
  // main-world script captured at extraction time lives under the
  // same origin as the tab actually loaded today.
  if (typeof sender.tab?.url !== "string") return false;
  try {
    return new URL(href).origin === new URL(sender.tab.url).origin;
  } catch {
    return false;
  }
}

function isRequestSubtitlePayload(value: unknown): value is RequestSubtitlePayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "subflow:request-subtitle") return false;
  if (typeof v.videoId !== "string" || v.videoId.length === 0) return false;
  if (!Array.isArray(v.languagePriority)) return false;
  // Reject blank / whitespace-only entries AND entries with leading
  // or trailing whitespace. SPEC §7.4 says storage-time validation
  // trims; we double-check here so a forged or buggy message can't
  // sneak a `"en "` through (which would never match tracks via the
  // case-insensitive comparison, and would inject whitespace into
  // both cache keys and tlang URLs).
  return v.languagePriority.every(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry === entry.trim(),
  );
}

function isRefetchSubtitlePayload(value: unknown): value is RefetchSubtitlePayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "subflow:refetch-subtitle" &&
    typeof v.videoId === "string" &&
    v.videoId.length > 0
  );
}

function isVideoChangedPayload(value: unknown): value is VideoChangedPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "subflow:video-changed" &&
    typeof v.videoId === "string" &&
    v.videoId.length > 0
  );
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!hasSubflowType(message)) return false;
  if (!isFromYouTubeTab(sender)) return false;
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return false;

  switch (message.type) {
    case PLAYER_DATA_POSTMESSAGE_TAG:
      if (!isPlayerDataPayload(message)) return false;
      if (!isFromSameHrefOrigin(message.href, sender)) return false;
      subtitles.recordPlayerData(tabId, message.result);
      sendResponse({ ack: true });
      return false;

    case "subflow:request-subtitle":
      if (!isRequestSubtitlePayload(message)) return false;
      subtitles
        .getSubtitle(tabId, message.videoId, message.languagePriority)
        .then((result) => {
          sendResponse({ videoId: message.videoId, result });
        })
        .catch((err: unknown) => {
          // Unexpected: the service catches its own errors and
          // returns a typed SubtitleResult. If we end up here, surface
          // a fetch-failed result so the message port doesn't dangle
          // and the sender's Promise settles.
          sendResponse({
            videoId: message.videoId,
            result: {
              status: "fetch-failed",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      // Keep the message channel open so the async sendResponse fires.
      return true;

    case "subflow:refetch-subtitle":
      if (!isRefetchSubtitlePayload(message)) return false;
      subtitles.invalidateVideo(tabId, message.videoId);
      sendResponse({ ack: true });
      return false;

    case "subflow:video-changed":
      if (!isVideoChangedPayload(message)) return false;
      subtitles.changeVideo(tabId, message.videoId);
      sendResponse({ ack: true });
      return false;

    default:
      return false;
  }
});
