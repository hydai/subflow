import { describe, it, expect } from "vitest";
import { formatTimestamp } from "@/lib/format";

describe("formatTimestamp (SPEC §7.3)", () => {
  it("formats 309s without hours as 05:09", () => {
    expect(formatTimestamp(309, false)).toBe("05:09");
  });

  it("formats 5025s with hours as 01:23:45", () => {
    expect(formatTimestamp(5025, true)).toBe("01:23:45");
  });

  it("formats 0s without hours as 00:00", () => {
    expect(formatTimestamp(0, false)).toBe("00:00");
  });

  it("formats 359999s with hours as 99:59:59", () => {
    expect(formatTimestamp(359999, true)).toBe("99:59:59");
  });

  it("naturally extends hh beyond two digits for 360000s as 100:00:00", () => {
    expect(formatTimestamp(360000, true)).toBe("100:00:00");
  });

  it("formats 60s without hours as 01:00", () => {
    expect(formatTimestamp(60, false)).toBe("01:00");
  });
});
