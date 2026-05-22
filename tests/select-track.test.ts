import { describe, it, expect } from "vitest";
import { selectTrack } from "@/lib/select-track";
import type { CaptionTrack } from "@/lib/types";

function track(opts: {
  baseUrl: string;
  languageCode: string;
  kind?: "asr";
  isTranslatable: boolean;
}): CaptionTrack {
  return opts;
}

describe("selectTrack (SPEC §6.1.2 + §6.1.3)", () => {
  it("returns null when tracks is empty", () => {
    expect(selectTrack([], ["en"])).toBeNull();
  });

  it("returns null when languagePriority is empty", () => {
    expect(selectTrack([track({ baseUrl: "https://x", languageCode: "en", isTranslatable: true })], [])).toBeNull();
  });

  it("returns null when no track matches and none are translatable", () => {
    const tracks = [
      track({ baseUrl: "https://x", languageCode: "en", isTranslatable: false }),
      track({ baseUrl: "https://y", languageCode: "fr", isTranslatable: false }),
    ];
    expect(selectTrack(tracks, ["zh-TW"])).toBeNull();
  });

  it("direct-matches a human track on a single-priority list", () => {
    const tracks = [track({ baseUrl: "https://x", languageCode: "en", isTranslatable: true })];
    expect(selectTrack(tracks, ["en"])).toEqual({
      baseUrl: "https://x",
      languageCode: "en",
      source: "human",
    });
  });

  it("matches case-insensitively but preserves the track's original languageCode casing", () => {
    const tracks = [track({ baseUrl: "https://x", languageCode: "zh-TW", isTranslatable: false })];
    expect(selectTrack(tracks, ["zh-tw"])).toEqual({
      baseUrl: "https://x",
      languageCode: "zh-TW",
      source: "human",
    });
  });

  it("prefers human over auto within the same language", () => {
    const tracks = [
      track({ baseUrl: "https://auto", languageCode: "en", kind: "asr", isTranslatable: true }),
      track({ baseUrl: "https://human", languageCode: "en", isTranslatable: true }),
    ];
    expect(selectTrack(tracks, ["en"])?.baseUrl).toBe("https://human");
    expect(selectTrack(tracks, ["en"])?.source).toBe("human");
  });

  it("falls through to the second priority when the first has no match", () => {
    const tracks = [track({ baseUrl: "https://en", languageCode: "en", isTranslatable: false })];
    expect(selectTrack(tracks, ["fr", "en"])).toEqual({
      baseUrl: "https://en",
      languageCode: "en",
      source: "human",
    });
  });

  it("derives a translation when there is no direct match and a human translatable track exists", () => {
    const tracks = [
      track({ baseUrl: "https://en", languageCode: "en", isTranslatable: true }),
    ];
    const result = selectTrack(tracks, ["ja"]);
    expect(result?.source).toBe("translation");
    expect(result?.languageCode).toBe("ja");
    const url = new URL(result!.baseUrl);
    expect(url.searchParams.get("tlang")).toBe("ja");
  });

  it("breaks ties between two translatable human tracks by lowest array index", () => {
    const tracks = [
      track({ baseUrl: "https://en", languageCode: "en", isTranslatable: true }),
      track({ baseUrl: "https://fr", languageCode: "fr", isTranslatable: true }),
    ];
    const result = selectTrack(tracks, ["ja"]);
    expect(result?.source).toBe("translation");
    const url = new URL(result!.baseUrl);
    expect(url.origin + url.pathname).toBe("https://en/");
    expect(url.searchParams.get("tlang")).toBe("ja");
  });

  it("uses an auto translatable track when no human one is translatable", () => {
    const tracks = [
      track({ baseUrl: "https://en-human", languageCode: "en", isTranslatable: false }),
      track({ baseUrl: "https://en-auto", languageCode: "en", kind: "asr", isTranslatable: true }),
    ];
    const result = selectTrack(tracks, ["ja"]);
    expect(result?.source).toBe("translation");
    const url = new URL(result!.baseUrl);
    expect(url.origin + url.pathname).toBe("https://en-auto/");
    expect(url.searchParams.get("tlang")).toBe("ja");
  });

  it("overwrites an existing tlang query parameter when deriving a translation", () => {
    const tracks = [
      track({ baseUrl: "https://yt/timedtext?v=abc&lang=en&tlang=en", languageCode: "en", isTranslatable: true }),
    ];
    const result = selectTrack(tracks, ["ja"]);
    const url = new URL(result!.baseUrl);
    expect(url.searchParams.get("tlang")).toBe("ja");
    // Only one tlang param — the older one was overwritten, not appended.
    expect(url.searchParams.getAll("tlang")).toHaveLength(1);
    expect(url.searchParams.get("lang")).toBe("en");
  });

  it("skips a translatable track whose baseUrl is malformed and uses the next candidate", () => {
    const tracks = [
      track({ baseUrl: "not a url", languageCode: "en", isTranslatable: true }),
      track({ baseUrl: "https://fr-fallback", languageCode: "fr", isTranslatable: true }),
    ];
    const result = selectTrack(tracks, ["ja"]);
    expect(result?.source).toBe("translation");
    const url = new URL(result!.baseUrl);
    expect(url.origin + url.pathname).toBe("https://fr-fallback/");
    expect(url.searchParams.get("tlang")).toBe("ja");
  });

  it("falls through to the next priority when every translatable track in this priority has a malformed baseUrl", () => {
    const tracks = [
      track({ baseUrl: "not a url", languageCode: "en", isTranslatable: true }),
      track({ baseUrl: "https://ja", languageCode: "ja", isTranslatable: false }),
    ];
    // For "fr": no direct match, only one translatable track and its
    // baseUrl is malformed → translation fails → outer loop continues.
    // For "ja": direct match wins.
    const result = selectTrack(tracks, ["fr", "ja"]);
    expect(result).toEqual({
      baseUrl: "https://ja",
      languageCode: "ja",
      source: "human",
    });
  });

  it("commits to a translation under the first priority instead of falling through to a later direct match", () => {
    const tracks = [
      track({ baseUrl: "https://en", languageCode: "en", isTranslatable: true }),
      track({ baseUrl: "https://ja", languageCode: "ja", isTranslatable: false }),
    ];
    // Outer-priority semantics: each preferred language is decided
    // independently. "fr" has no direct match but a translatable
    // track exists, so "fr" produces a translation result — and we
    // stop. The "ja" direct match in the second slot never gets a
    // chance because the loop already returned.
    const result = selectTrack(tracks, ["fr", "ja"]);
    expect(result?.source).toBe("translation");
    expect(result?.languageCode).toBe("fr");
  });

  it("returns the first direct match within a priority even if a translatable exists in the same priority", () => {
    const tracks = [
      track({ baseUrl: "https://en-direct", languageCode: "en", isTranslatable: true }),
    ];
    const result = selectTrack(tracks, ["en"]);
    expect(result?.source).toBe("human");
    expect(result?.baseUrl).toBe("https://en-direct");
  });
});
