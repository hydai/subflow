// Pure extraction of `window.ytInitialPlayerResponse` into a Subflow-
// internal shape per SPEC §6.1.1 + §7.1. Lives in `src/lib/` rather
// than `src/content/` because it has zero DOM / runtime dependencies:
// callers pass in whatever they read off `window`, the function
// validates and returns either typed extracted data or a typed error.

import type {
  CaptionTrack,
  ExtractError,
  ExtractResult,
  ExtractedPlayerData,
  VideoDetails,
} from "./types";

export function extractPlayerData(playerResponse: unknown): ExtractResult {
  if (playerResponse === null || playerResponse === undefined) {
    return fail({ type: "MISSING_PLAYER_RESPONSE" });
  }
  if (typeof playerResponse !== "object") {
    return fail({
      type: "MALFORMED_PLAYER_RESPONSE",
      reason: `playerResponse is ${typeof playerResponse}, expected object`,
    });
  }

  const root = playerResponse as Record<string, unknown>;
  const videoDetails = extractVideoDetails(root.videoDetails);
  if (!videoDetails.ok) {
    return videoDetails;
  }

  const captionTracks = extractCaptionTracks(root.captions);

  const data: ExtractedPlayerData = {
    videoDetails: videoDetails.value,
    captionTracks,
  };
  return { ok: true, data };
}

type ExtractVideoDetailsResult =
  | { ok: true; value: VideoDetails }
  | { ok: false; error: ExtractError };

function extractVideoDetails(raw: unknown): ExtractVideoDetailsResult {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return {
      ok: false,
      error: { type: "MALFORMED_PLAYER_RESPONSE", reason: "missing videoDetails" },
    };
  }
  const vd = raw as Record<string, unknown>;
  if (typeof vd.videoId !== "string" || vd.videoId.length === 0) {
    return {
      ok: false,
      error: { type: "MALFORMED_PLAYER_RESPONSE", reason: "missing videoDetails.videoId" },
    };
  }

  const value: VideoDetails = {
    videoId: vd.videoId,
    isLive: vd.isLive === true,
    isUpcoming: vd.isUpcoming === true,
  };
  if (typeof vd.title === "string") value.title = vd.title;
  if (typeof vd.author === "string") value.author = vd.author;
  const length = parseLengthSeconds(vd.lengthSeconds);
  if (length !== undefined) value.lengthSeconds = length;

  return { ok: true, value };
}

function parseLengthSeconds(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === "string") {
    // Reject "definitely-not-a-number" rather than returning NaN.
    if (!/^\d+$/.test(raw)) return undefined;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return undefined;
}

function extractCaptionTracks(rawCaptions: unknown): CaptionTrack[] {
  if (rawCaptions === null || rawCaptions === undefined || typeof rawCaptions !== "object") {
    return [];
  }
  const renderer = (rawCaptions as Record<string, unknown>).playerCaptionsTracklistRenderer;
  if (renderer === null || renderer === undefined || typeof renderer !== "object") {
    return [];
  }
  const tracks = (renderer as Record<string, unknown>).captionTracks;
  if (!Array.isArray(tracks)) {
    return [];
  }
  return tracks.flatMap((entry) => {
    const sanitized = sanitizeCaptionTrack(entry);
    return sanitized ? [sanitized] : [];
  });
}

function sanitizeCaptionTrack(raw: unknown): CaptionTrack | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.baseUrl !== "string" || typeof t.languageCode !== "string") {
    return null;
  }
  const track: CaptionTrack = {
    baseUrl: t.baseUrl,
    languageCode: t.languageCode,
    isTranslatable: t.isTranslatable === true,
  };
  if (t.kind === "asr") {
    track.kind = "asr";
  }
  return track;
}

function fail(error: ExtractError): ExtractResult {
  return { ok: false, error };
}
