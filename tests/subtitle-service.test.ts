import { describe, it, expect, vi } from "vitest";
import { SubtitleService } from "@/background/subtitle-service";
import type { PlayerDataState } from "@/background/subtitle-service";
import type { CaptionTrack, ExtractedPlayerData } from "@/lib/types";

const SAMPLE_XML = `<transcript><text start="0" dur="2">hello</text></transcript>`;

function makePlayerData(opts: {
  videoId: string;
  lengthSeconds?: number;
  tracks: CaptionTrack[];
}): PlayerDataState {
  const data: ExtractedPlayerData = {
    videoDetails: {
      videoId: opts.videoId,
      isLive: false,
      isUpcoming: false,
      ...(opts.lengthSeconds !== undefined ? { lengthSeconds: opts.lengthSeconds } : {}),
    },
    captionTracks: opts.tracks,
  };
  return { ok: true, data };
}

const enTrack: CaptionTrack = {
  baseUrl: "https://yt/api/timedtext?v=abc&lang=en",
  languageCode: "en",
  isTranslatable: true,
};

describe("SubtitleService", () => {
  it("returns parse-failed when no player data has been recorded yet", async () => {
    const service = new SubtitleService({ fetchSubtitleXml: vi.fn() });
    const result = await service.getSubtitle(1, "abc", ["en"]);
    expect(result.status).toBe("parse-failed");
  });

  it("returns no-subtitle when selectTrack cannot match any track", async () => {
    const fetchSubtitleXml = vi.fn();
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [] }));
    const result = await service.getSubtitle(1, "abc", ["en"]);
    expect(result.status).toBe("no-subtitle");
    expect(fetchSubtitleXml).not.toHaveBeenCalled();
  });

  it("fetches, parses, and returns a SubtitleSuccess on the happy path", async () => {
    const fetchSubtitleXml = vi.fn().mockResolvedValue(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack], lengthSeconds: 120 }));
    const result = await service.getSubtitle(1, "abc", ["en"]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.language).toBe("en");
    expect(result.source).toBe("human");
    expect(result.transcript).toBe("hello");
    expect(result.transcriptWithTimestamps).toBe("[00:00] hello");
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(1);
    expect(fetchSubtitleXml).toHaveBeenCalledWith(enTrack.baseUrl);
  });

  it("hits cache on the second call with the same (tab, video, language)", async () => {
    const fetchSubtitleXml = vi.fn().mockResolvedValue(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack] }));
    await service.getSubtitle(1, "abc", ["en"]);
    await service.getSubtitle(1, "abc", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent in-flight requests onto a single fetch", async () => {
    let resolveFetch!: (xml: string) => void;
    const fetchSubtitleXml = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack] }));

    const a = service.getSubtitle(1, "abc", ["en"]);
    const b = service.getSubtitle(1, "abc", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(1);

    resolveFetch(SAMPLE_XML);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(1);
  });

  it("does not cache fetch failures — a retry refetches", async () => {
    const fetchSubtitleXml = vi
      .fn()
      .mockRejectedValueOnce(new Error("SUBTITLE_FETCH_FAILED:500"))
      .mockResolvedValueOnce(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack] }));

    const failed = await service.getSubtitle(1, "abc", ["en"]);
    expect(failed.status).toBe("fetch-failed");

    const succeeded = await service.getSubtitle(1, "abc", ["en"]);
    expect(succeeded.status).toBe("ok");
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(2);
  });

  it("invalidateVideo evicts every cache entry for the given video", async () => {
    const fetchSubtitleXml = vi.fn().mockResolvedValue(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack] }));

    await service.getSubtitle(1, "abc", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(1);
    service.invalidateVideo(1, "abc");
    await service.getSubtitle(1, "abc", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(2);
  });

  it("invalidateTab drops the entire tab's state", async () => {
    const fetchSubtitleXml = vi.fn().mockResolvedValue(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack] }));
    await service.getSubtitle(1, "abc", ["en"]);

    service.invalidateTab(1);
    // After tab close, the next call has no recorded player data and
    // returns parse-failed (no record yet for this tab).
    const result = await service.getSubtitle(1, "abc", ["en"]);
    expect(result.status).toBe("parse-failed");
    // …and crucially we did NOT refetch.
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(1);
  });

  it("changeVideo keeps cache entries for the new video but drops everything else", async () => {
    const fetchSubtitleXml = vi.fn().mockResolvedValue(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });

    // Cache entry for the old video.
    service.recordPlayerData(1, makePlayerData({ videoId: "OLD", tracks: [enTrack] }));
    await service.getSubtitle(1, "OLD", ["en"]);

    // SPA-navigate to a new video the tab has already cached at some
    // point. Seed the cache for that future video by recording
    // matching player data first.
    service.recordPlayerData(1, makePlayerData({ videoId: "NEW", tracks: [enTrack] }));
    await service.getSubtitle(1, "NEW", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(2);

    // Now the actual SPA-navigation event. After it, OLD entries are
    // gone; NEW entries survive.
    service.changeVideo(1, "NEW");
    // Re-record player data because changeVideo resets it.
    service.recordPlayerData(1, makePlayerData({ videoId: "NEW", tracks: [enTrack] }));

    // OLD is no longer cached, but we cannot probe it without player
    // data for OLD; what we CAN verify is that the NEW lookup did
    // not refetch.
    await service.getSubtitle(1, "NEW", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(2);
  });

  it("scopes cache by tabId — two tabs do not share cache entries", async () => {
    const fetchSubtitleXml = vi.fn().mockResolvedValue(SAMPLE_XML);
    const service = new SubtitleService({ fetchSubtitleXml });

    service.recordPlayerData(1, makePlayerData({ videoId: "abc", tracks: [enTrack] }));
    service.recordPlayerData(2, makePlayerData({ videoId: "abc", tracks: [enTrack] }));

    await service.getSubtitle(1, "abc", ["en"]);
    await service.getSubtitle(2, "abc", ["en"]);
    expect(fetchSubtitleXml).toHaveBeenCalledTimes(2);
  });

  it("surfaces a parse-failed result when player data extraction failed", async () => {
    const fetchSubtitleXml = vi.fn();
    const service = new SubtitleService({ fetchSubtitleXml });
    service.recordPlayerData(1, {
      ok: false,
      error: { type: "MISSING_PLAYER_RESPONSE" },
    });
    const result = await service.getSubtitle(1, "abc", ["en"]);
    expect(result.status).toBe("parse-failed");
    expect(fetchSubtitleXml).not.toHaveBeenCalled();
  });
});
