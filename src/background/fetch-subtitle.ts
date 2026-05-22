// Background-side fetch helper for YouTube timed-text URLs.
//
// SPEC §6.7 / §7.1 require that this request never carry the user's
// YouTube cookies, extra headers, or a forged Origin — only the
// extension's chrome-extension:// Origin (which Chrome supplies
// automatically). `credentials: "omit"` makes that contract explicit
// and keeps the request behaviour identical even if a future Chrome
// version starts including cookies by default for some reason.

export async function fetchSubtitleXml(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`SUBTITLE_FETCH_FAILED:${response.status}`);
  }
  return response.text();
}
