// Parse a YouTube timed-text XML response into Subflow's two
// transcript representations per SPEC §6.1.5 + §7.3:
//
//   - `transcript`: line-per-`<text>` plain string, no timestamps,
//     entities decoded.
//   - `transcriptWithTimestamps`: same lines prefixed with the
//     `<text>` element's `start` attribute as a SPEC §7.3 timestamp
//     (`[mm:ss]` if `videoDurationSec` is known and < 3600s,
//     `[hh:mm:ss]` otherwise — including the duration-unknown case
//     and any timestamp ≥ 100h).
//
// Pure function. No DOM dependency (MV3 service workers do NOT have
// `DOMParser`), so we extract `<text>` elements with a regex on the
// raw XML string; that's more than enough for YouTube's small,
// well-formed timed-text payloads.

import { formatTimestamp } from "./format";

export interface ParsedTimedText {
  transcript: string;
  transcriptWithTimestamps: string;
}

const TEXT_TAG_RE = /<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;

export function parseTimedText(
  xml: string,
  videoDurationSec: number | undefined,
): ParsedTimedText {
  const useHours = videoDurationSec === undefined || videoDurationSec >= 3600;

  const lines: Array<{ startSeconds: number; text: string }> = [];
  for (const match of xml.matchAll(TEXT_TAG_RE)) {
    const startSeconds = Math.floor(Number.parseFloat(match[1]!));
    if (!Number.isFinite(startSeconds)) continue;
    const text = decodeEntities(match[2]!);
    lines.push({ startSeconds, text });
  }

  const transcript = lines.map((l) => l.text).join("\n");
  const transcriptWithTimestamps = lines
    .map((l) => `[${formatTimestamp(l.startSeconds, useHours)}] ${l.text}`)
    .join("\n");
  return { transcript, transcriptWithTimestamps };
}

// Decode the HTML entities YouTube actually uses in timed-text
// payloads. Order matters: `&amp;` is replaced LAST so an input like
// `&amp;lt;` decodes to literal `&lt;` rather than `<` (single-pass
// rule).
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&amp;/g, "&");
}
