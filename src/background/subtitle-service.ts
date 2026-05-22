// Subtitle service for the background worker.
//
// Stitches #4 (player-response extraction → playerData state), #5
// (selectTrack), and #6 (parseTimedText) into a single "(tabId,
// videoId, languagePriority) → SubtitleResult" API while caring for:
//
//   - Tab-scoped in-memory cache keyed by `(videoId, matched
//     languageCode)` per SPEC §6.2.
//   - In-flight Promise dedup so concurrent callers share a single
//     fetch per cache key (§6.7).
//   - chrome.tabs.onRemoved-style cleanup via `invalidateTab`.
//   - SPA-navigation cleanup via `changeVideo`: drops cache entries
//     for any video other than the new one (the new video's entries,
//     if any, are kept so a back-navigation re-uses them).
//
// The service is constructor-injected with its IO dependencies so
// every behavior in this file is testable without `chrome.*` or the
// network. Only `src/background/index.ts` wires the real chrome /
// fetch implementations on top.

import { selectTrack } from "@/lib/select-track";
import { parseTimedText } from "@/lib/parse-timed-text";
import type {
  ExtractError,
  ExtractedPlayerData,
  SubtitleFailure,
  SubtitleResult,
  SubtitleStatus,
  SubtitleSuccess,
  SelectedTrack,
} from "@/lib/types";

export type PlayerDataState =
  | { ok: true; data: ExtractedPlayerData }
  | { ok: false; error: ExtractError };

export interface SubtitleServiceDeps {
  // Fetch the timed-text XML for a baseUrl. Implementations should
  // omit credentials so the request never carries YouTube cookies.
  // Throwing or returning a non-2xx response is mapped to the
  // `fetch-failed` SubtitleResult variant by the service itself.
  fetchSubtitleXml: (baseUrl: string) => Promise<string>;
}

interface TabState {
  playerData: PlayerDataState | null;
  subtitleCache: Map<string, SubtitleSuccess>;
  inFlight: Map<string, Promise<SubtitleResult>>;
  // Bumped on every invalidation (invalidateVideo / changeVideo).
  // An in-flight fetch captures the epoch at start and only writes
  // its result to the cache if the epoch is still current when it
  // resolves — so an invalidation that races with an in-flight fetch
  // can't be "undone" by the late-arriving response.
  epoch: number;
}

export class SubtitleService {
  private readonly tabs = new Map<number, TabState>();

  constructor(private readonly deps: SubtitleServiceDeps) {}

  // The content-script bridge (#4) hands us the latest player-data
  // extraction result for a given tab. We just store it; the next
  // getSubtitle call uses it as the source of caption tracks and
  // video metadata.
  recordPlayerData(tabId: number, playerData: PlayerDataState): void {
    const state = this.touch(tabId);
    state.playerData = playerData;
  }

  // "(tabId, videoId, languagePriority) → SubtitleResult".
  async getSubtitle(
    tabId: number,
    videoId: string,
    languagePriority: string[],
  ): Promise<SubtitleResult> {
    // SPEC §6.6: missing language preference takes precedence over
    // any other failure — the sidebar redirects the user to settings
    // before we go anywhere near the player data.
    if (languagePriority.length === 0) {
      return failure("missing-language-priority");
    }

    const state = this.touch(tabId);
    const playerData = state.playerData;
    if (playerData === null) {
      return failure("parse-failed", "player data not yet available for this tab");
    }
    if (!playerData.ok) {
      // MALFORMED_PLAYER_RESPONSE carries an explanatory `reason`;
      // surface it as the message so the sidebar / logs can show
      // why parsing failed. MISSING_PLAYER_RESPONSE has no extra
      // diagnostic, so we fall back to the type string.
      const message =
        playerData.error.type === "MALFORMED_PLAYER_RESPONSE"
          ? playerData.error.reason
          : playerData.error.type;
      return failure(extractErrorToStatus(playerData.error), message);
    }

    // Guard against the SPA-navigation race where a request lands
    // for a video whose player data has not yet replaced the
    // previous video's. Caching for the wrong key would persist
    // incorrect subtitles after the navigation completes.
    if (playerData.data.videoDetails.videoId !== videoId) {
      return failure(
        "parse-failed",
        "recorded player data is for a different video; waiting for re-extraction",
      );
    }

    // SPEC §6.6: live / premiere videos surface their own dedicated
    // status, separately from "no subtitle".
    if (playerData.data.videoDetails.isLive || playerData.data.videoDetails.isUpcoming) {
      return failure("live-or-premiere");
    }

    // selectTrack is pure but accesses `.languageCode` and `.baseUrl`
    // on every track entry. If a malformed track somehow slipped past
    // the inbound validator (defense in depth — the only known path
    // would be a future code change that loosens validation), wrap
    // the call so the service still emits a typed result rather than
    // rejecting and bouncing to the router's safety-net catch.
    let selected;
    try {
      selected = selectTrack(playerData.data.captionTracks, languagePriority);
    } catch (err) {
      return failure(
        "parse-failed",
        err instanceof Error ? err.message : "selectTrack threw on malformed caption tracks",
      );
    }
    if (selected === null) {
      return failure("no-subtitle");
    }

    const cacheKey = makeKey(videoId, selected.languageCode);
    const cached = state.subtitleCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = state.inFlight.get(cacheKey);
    if (inFlight !== undefined) return inFlight;

    const epochAtStart = state.epoch;
    const promise = this.runFetch(playerData.data, selected);
    state.inFlight.set(cacheKey, promise);
    try {
      const result = await promise;
      // Skip the cache write if this fetch was invalidated mid-flight.
      // The caller still receives `result` (they were waiting for it),
      // but the stale data does not stick around to fool the next
      // request.
      if (result.status === "ok" && state.epoch === epochAtStart) {
        state.subtitleCache.set(cacheKey, result);
      }
      return result;
    } finally {
      // Only retract the in-flight entry if it still points at our
      // promise — invalidation may have already removed it.
      if (state.inFlight.get(cacheKey) === promise) {
        state.inFlight.delete(cacheKey);
      }
    }
  }

  // Manual refresh path for the sidebar (#12 will trigger this).
  // Removes every cache entry for the given (tab, video) so the next
  // getSubtitle call goes back through fetch + parse. Also evicts
  // any in-flight entries for the same video and bumps the tab's
  // epoch — any fetch already mid-flight at this moment will deliver
  // its result to the original caller but will NOT cache it, so a
  // subsequent getSubtitle call after invalidation always sees a
  // cache miss.
  invalidateVideo(tabId: number, videoId: string): void {
    const state = this.tabs.get(tabId);
    if (state === undefined) return;
    const prefix = `${videoId}|`;
    for (const key of state.subtitleCache.keys()) {
      if (key.startsWith(prefix)) state.subtitleCache.delete(key);
    }
    for (const key of state.inFlight.keys()) {
      if (key.startsWith(prefix)) state.inFlight.delete(key);
    }
    state.epoch += 1;
  }

  // Tab-close cleanup — drop the entire tab's state.
  invalidateTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  // SPA-navigation cleanup. Drop cache entries that do not belong to
  // the new video and (only when needed) reset the cached player data
  // so the content script's re-extraction lands cleanly. The new
  // video's own cache entries (if any from a prior visit in this
  // tab) are kept so a back-navigation re-uses them. Also evict
  // in-flight entries for the previous video and bump the epoch so a
  // fetch that was running for the previous video can't write a
  // stale entry after the SPA switch.
  //
  // Idempotency: the content-script bridge sends `video-changed` and
  // a re-extraction request on separate channels (chrome.runtime vs.
  // window.postMessage), so the re-extracted player data may arrive
  // before this call. If the recorded playerData is ALREADY for the
  // new videoId, we leave it in place; otherwise we clear it so the
  // pending re-extraction can replace it without racing.
  changeVideo(tabId: number, newVideoId: string): void {
    const state = this.tabs.get(tabId);
    if (state === undefined) return;

    const recordedVideoId =
      state.playerData?.ok === true
        ? state.playerData.data.videoDetails.videoId
        : null;
    if (recordedVideoId !== newVideoId) {
      state.playerData = null;
    }

    const prefix = `${newVideoId}|`;
    for (const key of state.subtitleCache.keys()) {
      if (!key.startsWith(prefix)) state.subtitleCache.delete(key);
    }
    for (const key of state.inFlight.keys()) {
      if (!key.startsWith(prefix)) state.inFlight.delete(key);
    }
    state.epoch += 1;
  }

  private touch(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (state === undefined) {
      state = {
        playerData: null,
        subtitleCache: new Map(),
        inFlight: new Map(),
        epoch: 0,
      };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  private async runFetch(
    playerData: ExtractedPlayerData,
    selected: SelectedTrack,
  ): Promise<SubtitleResult> {
    let xml: string;
    try {
      xml = await this.deps.fetchSubtitleXml(selected.baseUrl);
    } catch (err) {
      return failure("fetch-failed", err instanceof Error ? err.message : String(err));
    }
    const parsed = parseTimedText(xml, playerData.videoDetails.lengthSeconds);
    const success: SubtitleSuccess = {
      status: "ok",
      transcript: parsed.transcript,
      transcriptWithTimestamps: parsed.transcriptWithTimestamps,
      language: selected.languageCode,
      source: selected.source,
    };
    return success;
  }
}

function makeKey(videoId: string, languageCode: string): string {
  return `${videoId}|${languageCode}`;
}

function failure(status: Exclude<SubtitleStatus, "ok">, message?: string): SubtitleFailure {
  return message !== undefined ? { status, message } : { status };
}

function extractErrorToStatus(error: ExtractError): Exclude<SubtitleStatus, "ok"> {
  // §6.6 maps both "missing" and "malformed" player-response cases to
  // the sidebar copy "無法解析 YouTube 頁面資料"; we surface both as
  // `parse-failed`. The default fallback exists for runtime safety:
  // if a future ExtractError variant lands without updating this map,
  // emit parse-failed rather than an invalid `{ status: undefined }`
  // SubtitleResult. TypeScript will still warn on the unhandled case
  // because the switch is no longer exhaustive over the union, but
  // production runtime stays well-typed.
  switch (error.type) {
    case "MISSING_PLAYER_RESPONSE":
    case "MALFORMED_PLAYER_RESPONSE":
      return "parse-failed";
    default:
      return "parse-failed";
  }
}
