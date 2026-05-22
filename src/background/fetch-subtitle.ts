// Background-side fetch helper for YouTube timed-text URLs.
//
// SPEC §6.7 / §7.1 require that this request never carry the user's
// YouTube cookies, extra headers, or a forged Origin — only the
// extension's chrome-extension:// Origin (which Chrome supplies
// automatically). `credentials: "omit"` makes that contract explicit
// and keeps the request behaviour identical even if a future Chrome
// version starts including cookies by default for some reason.
//
// Defensive URL allowlist: a compromised caller could in principle
// hand us a baseUrl pointing somewhere else, so we double-check that
// the URL is a YouTube timed-text endpoint before issuing the fetch.
// `redirect: "error"` then prevents a redirect from steering the
// response away from www.youtube.com after the request leaves.

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const TIMEDTEXT_PATH = "/api/timedtext";

export async function fetchSubtitleXml(baseUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`SUBTITLE_FETCH_FAILED:bad-url`);
  }
  if (url.origin !== YOUTUBE_ORIGIN || !url.pathname.startsWith(TIMEDTEXT_PATH)) {
    throw new Error(`SUBTITLE_FETCH_FAILED:disallowed-url`);
  }
  const response = await fetch(baseUrl, { credentials: "omit", redirect: "error" });
  if (!response.ok) {
    throw new Error(`SUBTITLE_FETCH_FAILED:${response.status}`);
  }
  return response.text();
}
