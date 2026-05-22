import { describe, it, expect } from "vitest";
import { extractPlayerData } from "@/lib/extract";

const happyPlayerResponse = {
  videoDetails: {
    videoId: "dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    author: "Rick Astley",
    lengthSeconds: "212",
    isLive: false,
    isUpcoming: false,
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
          languageCode: "en",
          isTranslatable: true,
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr",
          languageCode: "en",
          kind: "asr",
          isTranslatable: false,
        },
      ],
    },
  },
};

describe("extractPlayerData (SPEC §6.1.1, §7.1)", () => {
  it("returns success with full video details and caption tracks on the happy path", () => {
    const result = extractPlayerData(happyPlayerResponse);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoDetails).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      author: "Rick Astley",
      lengthSeconds: 212,
      isLive: false,
      isUpcoming: false,
    });
    expect(result.data.captionTracks).toEqual([
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
        languageCode: "en",
        isTranslatable: true,
      },
      {
        baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr",
        languageCode: "en",
        kind: "asr",
        isTranslatable: false,
      },
    ]);
  });

  it("returns MISSING_PLAYER_RESPONSE when the input is null", () => {
    const result = extractPlayerData(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("MISSING_PLAYER_RESPONSE");
  });

  it("returns MISSING_PLAYER_RESPONSE when the input is undefined", () => {
    const result = extractPlayerData(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("MISSING_PLAYER_RESPONSE");
  });

  it("returns MALFORMED_PLAYER_RESPONSE when the input is a primitive", () => {
    const result = extractPlayerData("not an object");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("MALFORMED_PLAYER_RESPONSE");
  });

  it("returns MALFORMED_PLAYER_RESPONSE when videoDetails is missing", () => {
    const result = extractPlayerData({ captions: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("MALFORMED_PLAYER_RESPONSE");
  });

  it("returns MALFORMED_PLAYER_RESPONSE when videoDetails.videoId is missing", () => {
    const result = extractPlayerData({ videoDetails: { title: "x" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("MALFORMED_PLAYER_RESPONSE");
  });

  it("returns success with an empty caption track list when captions is absent", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc", isLive: false, isUpcoming: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.captionTracks).toEqual([]);
  });

  it("returns success with an empty caption track list when playerCaptionsTracklistRenderer is absent", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc" },
      captions: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.captionTracks).toEqual([]);
  });

  it("returns success with an empty caption track list when captionTracks is not an array", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: "oops" } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.captionTracks).toEqual([]);
  });

  it("filters caption tracks that are missing required fields", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "https://x", languageCode: "en", isTranslatable: true },
            { baseUrl: "https://y" }, // missing languageCode
            { languageCode: "fr" }, // missing baseUrl
            { baseUrl: "https://z", languageCode: "ja", isTranslatable: false },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.captionTracks).toHaveLength(2);
    expect(result.data.captionTracks[0]!.languageCode).toBe("en");
    expect(result.data.captionTracks[1]!.languageCode).toBe("ja");
  });

  it("converts numeric lengthSeconds string to number", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc", lengthSeconds: "5025" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoDetails.lengthSeconds).toBe(5025);
  });

  it("leaves lengthSeconds undefined when it is a non-numeric string (not NaN)", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc", lengthSeconds: "definitely-not-a-number" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoDetails.lengthSeconds).toBeUndefined();
  });

  it("leaves lengthSeconds undefined when the field is missing entirely", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoDetails.lengthSeconds).toBeUndefined();
  });

  it("accepts a numeric lengthSeconds field already typed as number", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc", lengthSeconds: 309 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoDetails.lengthSeconds).toBe(309);
  });

  it("preserves isLive and isUpcoming when they are true", () => {
    const live = extractPlayerData({
      videoDetails: { videoId: "abc", isLive: true },
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.data.videoDetails.isLive).toBe(true);
    expect(live.data.videoDetails.isUpcoming).toBe(false);

    const upcoming = extractPlayerData({
      videoDetails: { videoId: "abc", isUpcoming: true },
    });
    expect(upcoming.ok).toBe(true);
    if (!upcoming.ok) return;
    expect(upcoming.data.videoDetails.isUpcoming).toBe(true);
    expect(upcoming.data.videoDetails.isLive).toBe(false);
  });

  it("treats non-boolean isLive / isUpcoming values as false", () => {
    const result = extractPlayerData({
      videoDetails: { videoId: "abc", isLive: "true", isUpcoming: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.videoDetails.isLive).toBe(false);
    expect(result.data.videoDetails.isUpcoming).toBe(false);
  });

});
