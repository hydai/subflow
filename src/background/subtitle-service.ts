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
    const state = this.touch(tabId);
    const playerData = state.playerData;
    if (playerData === null) {
      return failure("parse-failed", "player data not yet available for this tab");
    }
    if (!playerData.ok) {
      const error = playerData.error;
      return failure(extractErrorToStatus(error), playerData.error.type);
    }

    const selected = selectTrack(playerData.data.captionTracks, languagePriority);
    if (selected === null) {
      return failure("no-subtitle");
    }

    const cacheKey = makeKey(videoId, selected.languageCode);
    const cached = state.subtitleCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = state.inFlight.get(cacheKey);
    if (inFlight !== undefined) return inFlight;

    const promise = this.runFetch(playerData.data, selected);
    state.inFlight.set(cacheKey, promise);
    try {
      const result = await promise;
      if (result.status === "ok") {
        state.subtitleCache.set(cacheKey, result);
      }
      return result;
    } finally {
      state.inFlight.delete(cacheKey);
    }
  }

  // Manual refresh path for the sidebar (#12 will trigger this).
  // Removes every cache entry for the given (tab, video) so the next
  // getSubtitle call goes back through fetch + parse.
  invalidateVideo(tabId: number, videoId: string): void {
    const state = this.tabs.get(tabId);
    if (state === undefined) return;
    const prefix = `${videoId}|`;
    for (const key of state.subtitleCache.keys()) {
      if (key.startsWith(prefix)) state.subtitleCache.delete(key);
    }
  }

  // Tab-close cleanup — drop the entire tab's state.
  invalidateTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  // SPA-navigation cleanup. Drop cache entries that do not belong to
  // the new video, and reset the cached player data because the
  // content script will re-extract for the new page. The new
  // video's own cache entries (if any from a prior visit in this
  // tab) are kept so a back-navigation re-uses them.
  changeVideo(tabId: number, newVideoId: string): void {
    const state = this.tabs.get(tabId);
    if (state === undefined) return;
    state.playerData = null;
    const prefix = `${newVideoId}|`;
    for (const key of state.subtitleCache.keys()) {
      if (!key.startsWith(prefix)) state.subtitleCache.delete(key);
    }
  }

  private touch(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (state === undefined) {
      state = {
        playerData: null,
        subtitleCache: new Map(),
        inFlight: new Map(),
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
  // `parse-failed`.
  switch (error.type) {
    case "MISSING_PLAYER_RESPONSE":
    case "MALFORMED_PLAYER_RESPONSE":
      return "parse-failed";
  }
}
