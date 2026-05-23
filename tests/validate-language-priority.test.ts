import { describe, it, expect } from "vitest";
import { validateLanguagePriority } from "@/lib/validate-language-priority";

describe("validateLanguagePriority (SPEC §6.8 / §7.4)", () => {
  it("returns an error when the list is empty", () => {
    const result = validateLanguagePriority([]);
    expect(result.trimmed).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/at least one language/i);
  });

  it("returns an error when the only entry trims to empty", () => {
    const result = validateLanguagePriority(["   "]);
    expect(result.trimmed).toEqual([""]);
    expect(result.errors.length).toBeGreaterThan(0);
    // Both a per-row error AND a list-level error appear since
    // every row is blank.
    expect(result.errors.some((e) => e.index === 0)).toBe(true);
    expect(result.errors.some((e) => e.index === undefined)).toBe(true);
  });

  it("blocks save when a middle entry is blank (no silent drop)", () => {
    const result = validateLanguagePriority(["zh-TW", "   ", "en"]);
    expect(result.trimmed).toEqual(["zh-TW", "", "en"]);
    const middleErr = result.errors.find((e) => e.index === 1);
    expect(middleErr).toBeDefined();
    expect(middleErr?.message).toContain("Language 2");
  });

  it("returns OK for a list of valid codes", () => {
    const result = validateLanguagePriority(["zh-TW", "en"]);
    expect(result.trimmed).toEqual(["zh-TW", "en"]);
    expect(result.errors).toEqual([]);
  });

  it("trims surrounding whitespace while preserving original case (SPEC §6.1 matches case-insensitive)", () => {
    const result = validateLanguagePriority(["  zh-TW  ", "  EN  ", "  ja-JP  "]);
    expect(result.trimmed).toEqual(["zh-TW", "EN", "ja-JP"]);
    expect(result.errors).toEqual([]);
  });

  it("does not enforce BCP-47 syntax — accepts unknown / future codes", () => {
    // SPEC §7.4 deliberately skips BCP-47 syntax validation so rare
    // or future codes aren't rejected.
    const result = validateLanguagePriority(["x-private", "und", "zh-Hant-TW"]);
    expect(result.errors).toEqual([]);
  });
});
