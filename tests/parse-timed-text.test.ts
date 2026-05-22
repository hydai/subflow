import { describe, it, expect } from "vitest";
import { parseTimedText } from "@/lib/parse-timed-text";

const sampleXml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0" dur="2.5">First line</text>
  <text start="2.5" dur="1.5">Second line with &amp; ampersand</text>
  <text start="4" dur="2">&lt;tag&gt; and &quot;quotes&quot;</text>
</transcript>`;

describe("parseTimedText (SPEC §6.1.5 + §7.3)", () => {
  it("uses [mm:ss] for short videos (duration < 1h)", () => {
    const { transcriptWithTimestamps } = parseTimedText(sampleXml, 600);
    const lines = transcriptWithTimestamps.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}\]/);
    expect(lines[0]).not.toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    expect(lines[0]).toBe("[00:00] First line");
  });

  it("uses [hh:mm:ss] for long videos (duration >= 1h)", () => {
    const { transcriptWithTimestamps } = parseTimedText(sampleXml, 3600);
    const lines = transcriptWithTimestamps.split("\n");
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    expect(lines[0]).toBe("[00:00:00] First line");
  });

  it("naturally extends the hh field past two digits for videos >= 100h", () => {
    // Build a single-line XML with a start time of exactly 360000s (100h).
    const xml = `<transcript><text start="360000" dur="1">marker</text></transcript>`;
    const { transcriptWithTimestamps } = parseTimedText(xml, 360000);
    expect(transcriptWithTimestamps).toBe("[100:00:00] marker");
  });

  it("falls back to [hh:mm:ss] when videoDurationSec is undefined", () => {
    const { transcriptWithTimestamps } = parseTimedText(sampleXml, undefined);
    const firstLine = transcriptWithTimestamps.split("\n")[0]!;
    expect(firstLine).toBe("[00:00:00] First line");
  });

  it("decodes the common HTML entities the YouTube feed uses", () => {
    const { transcript } = parseTimedText(sampleXml, 600);
    const lines = transcript.split("\n");
    expect(lines[1]).toBe("Second line with & ampersand");
    expect(lines[2]).toBe('<tag> and "quotes"');
  });

  it("returns transcript with `\\n`-separated lines, no timestamps", () => {
    const { transcript } = parseTimedText(sampleXml, 600);
    expect(transcript).toBe(
      ["First line", "Second line with & ampersand", '<tag> and "quotes"'].join("\n"),
    );
  });

  it("returns two empty strings when the XML has no <text> elements", () => {
    expect(parseTimedText("", 600)).toEqual({ transcript: "", transcriptWithTimestamps: "" });
    expect(parseTimedText("<transcript></transcript>", 600)).toEqual({
      transcript: "",
      transcriptWithTimestamps: "",
    });
  });

  it("renders start=0 as a zero-padded timestamp (00:00 or 00:00:00)", () => {
    const xml = `<transcript><text start="0" dur="1">x</text></transcript>`;
    expect(parseTimedText(xml, 600).transcriptWithTimestamps).toBe("[00:00] x");
    expect(parseTimedText(xml, 3600).transcriptWithTimestamps).toBe("[00:00:00] x");
  });

  it("uses a uniform format across an entire transcript (no mm:ss / hh:mm:ss mixing)", () => {
    const xml = `<transcript>
      <text start="59" dur="1">just before 1m</text>
      <text start="60" dur="1">at 1m</text>
      <text start="3600" dur="1">at 1h</text>
    </transcript>`;
    // Long video: every line uses [hh:mm:ss]. The 3600s line is exactly
    // `[01:00:00]`.
    const long = parseTimedText(xml, 3600);
    expect(long.transcriptWithTimestamps.split("\n")).toEqual([
      "[00:00:59] just before 1m",
      "[00:01:00] at 1m",
      "[01:00:00] at 1h",
    ]);
    // Short video: every line uses [mm:ss], even the one at 3600s.
    // The mm field extends naturally to two-or-more digits so 3600s
    // renders as `[60:00]`, not the collapsed `[00:00]`.
    const short = parseTimedText(xml, 600);
    expect(short.transcriptWithTimestamps.split("\n")).toEqual([
      "[00:59] just before 1m",
      "[01:00] at 1m",
      "[60:00] at 1h",
    ]);
  });

  it("floors fractional start values to whole seconds", () => {
    const xml = `<transcript><text start="0.9" dur="1">x</text></transcript>`;
    expect(parseTimedText(xml, 600).transcriptWithTimestamps).toBe("[00:00] x");
  });

  it("decodes numeric character references", () => {
    const xml = `<transcript><text start="0" dur="1">&#39; and &#x27;</text></transcript>`;
    expect(parseTimedText(xml, 600).transcript).toBe("' and '");
  });

  it("leaves malformed numeric character references in place instead of throwing", () => {
    // 0x110000 is one past the Unicode max (0x10FFFF); fromCodePoint
    // would throw. The parser must keep going and emit the entity
    // verbatim so a single bad reference doesn't lose the whole line.
    const xml = `<transcript><text start="0" dur="1">x &#x110000; y</text></transcript>`;
    expect(parseTimedText(xml, 600).transcript).toBe("x &#x110000; y");
  });
});
