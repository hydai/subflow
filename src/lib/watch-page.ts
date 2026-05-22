// Watch-page URL parser per SPEC §6.4 (sidebar lifecycle):
// "visit `https://www.youtube.com/watch?v=…` → sidebar injected,
// any other YouTube path → sidebar removed".
//
// Pure function so the content-script logic in #11 can test the
// route decision without any DOM. A return of `null` means "this URL
// is not a Subflow-eligible YouTube watch page, do not inject"; a
// non-null return carries the extracted `videoId` so the caller can
// fan it out to the SubtitleService and downstream message router.

export interface WatchPageInfo {
  videoId: string;
}

export function parseWatchPageUrl(href: string): WatchPageInfo | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // Only the canonical YouTube watch route counts. /shorts/<id>,
  // /channel/<id>, /, /results, etc. all fall through here.
  if (url.pathname !== "/watch") return null;
  // YouTube ignores anything but the `www.youtube.com` host on the
  // watch route. Match the manifest's host_permissions exactly.
  if (url.hostname !== "www.youtube.com") return null;
  const videoId = url.searchParams.get("v");
  if (videoId === null || videoId.length === 0) return null;
  return { videoId };
}
