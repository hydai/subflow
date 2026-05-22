import { describe, it, expect } from "vitest";
import { substitute } from "@/lib/substitute";
import type { PromptVariables } from "@/lib/types";

const baseVars: PromptVariables = {
  transcript: "hello world",
  transcript_with_timestamps: "[00:00] hello world",
  title: "Test Video",
  video_id: "abc123",
  video_url: "https://www.youtube.com/watch?v=abc123",
  channel: "Test Channel",
  language: "en",
  duration_seconds: 309,
};

describe("substitute (SPEC §7.3)", () => {
  it("replaces every known variable when all are defined", () => {
    const template = "Title: {{title}}\nTranscript: {{transcript}}\nLanguage: {{language}}\nDuration: {{duration_seconds}}";
    expect(substitute(template, baseVars)).toBe(
      "Title: Test Video\nTranscript: hello world\nLanguage: en\nDuration: 309",
    );
  });

  it("leaves an undefined variable's placeholder verbatim", () => {
    const vars: PromptVariables = { ...baseVars, title: undefined };
    expect(substitute("Hello {{title}}", vars)).toBe("Hello {{title}}");
  });

  it("leaves a misspelled variable's placeholder verbatim", () => {
    expect(substitute("Type: {{transcr1pt}}", baseVars)).toBe("Type: {{transcr1pt}}");
  });

  it("performs a single-pass replacement (substituted text is not re-scanned)", () => {
    // If the transcript itself contains "{{transcript}}", the substituted
    // value must NOT be re-scanned and re-substituted into infinity.
    const vars: PromptVariables = { ...baseVars, transcript: "wraps {{transcript}} inside" };
    expect(substitute("Body: {{transcript}}", vars)).toBe("Body: wraps {{transcript}} inside");
  });

  it("treats `duration_seconds` of 0 as a defined value (renders as \"0\")", () => {
    const vars: PromptVariables = { ...baseVars, duration_seconds: 0 };
    expect(substitute("Length: {{duration_seconds}}", vars)).toBe("Length: 0");
  });

  it("returns the template unchanged when it has no placeholders", () => {
    expect(substitute("plain text", baseVars)).toBe("plain text");
  });

  it("returns an empty string for an empty template", () => {
    expect(substitute("", baseVars)).toBe("");
  });

  it("supports every documented SPEC §7.3 variable", () => {
    const template = "{{transcript}}|{{transcript_with_timestamps}}|{{title}}|{{video_id}}|{{video_url}}|{{channel}}|{{language}}|{{duration_seconds}}";
    expect(substitute(template, baseVars)).toBe(
      "hello world|[00:00] hello world|Test Video|abc123|https://www.youtube.com/watch?v=abc123|Test Channel|en|309",
    );
  });

  it("does not consume placeholders whose content is not a valid \\w+ identifier", () => {
    // Empty `{{}}`, hyphenated `{{my-var}}`, dotted `{{a.b}}`, and
    // whitespaced `{{a b}}` all fail the `\w+` requirement and pass
    // through verbatim — only the documented variable set is
    // substitution-eligible.
    expect(substitute("Cases: {{}} {{my-var}} {{a.b}} {{a b}}", baseVars)).toBe(
      "Cases: {{}} {{my-var}} {{a.b}} {{a b}}",
    );
  });
});
