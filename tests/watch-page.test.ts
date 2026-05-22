import { describe, it, expect } from "vitest";
import { parseWatchPageUrl } from "@/lib/watch-page";

describe("parseWatchPageUrl (SPEC §6.4)", () => {
  it("extracts videoId from a canonical watch URL", () => {
    expect(parseWatchPageUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      videoId: "dQw4w9WgXcQ",
    });
  });

  it("preserves extra query parameters but ignores them", () => {
    expect(
      parseWatchPageUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123"),
    ).toEqual({ videoId: "dQw4w9WgXcQ" });
  });

  it("returns null when the path is not /watch", () => {
    expect(parseWatchPageUrl("https://www.youtube.com/")).toBeNull();
    expect(parseWatchPageUrl("https://www.youtube.com/results?search_query=cats")).toBeNull();
    expect(parseWatchPageUrl("https://www.youtube.com/shorts/abc123")).toBeNull();
    expect(parseWatchPageUrl("https://www.youtube.com/channel/UC123")).toBeNull();
  });

  it("returns null when the v parameter is missing", () => {
    expect(parseWatchPageUrl("https://www.youtube.com/watch")).toBeNull();
    expect(parseWatchPageUrl("https://www.youtube.com/watch?t=42")).toBeNull();
  });

  it("returns null when the v parameter is empty", () => {
    expect(parseWatchPageUrl("https://www.youtube.com/watch?v=")).toBeNull();
  });

  it("returns null for non-www.youtube.com hosts", () => {
    expect(parseWatchPageUrl("https://m.youtube.com/watch?v=abc")).toBeNull();
    expect(parseWatchPageUrl("https://music.youtube.com/watch?v=abc")).toBeNull();
    expect(parseWatchPageUrl("https://youtube.com/watch?v=abc")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseWatchPageUrl("not a url")).toBeNull();
    expect(parseWatchPageUrl("")).toBeNull();
  });
});
