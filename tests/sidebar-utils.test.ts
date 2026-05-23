import { describe, it, expect } from "vitest";
import {
  truncateBody,
  addResult,
  ERROR_BODY_CHAR_LIMIT,
  RESULT_LIST_MAX_LENGTH,
} from "@/lib/sidebar-utils";
import type { WorkflowResult } from "@/lib/types";

function result(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    workflowId: "wf-1",
    workflowName: "Summarize",
    outcome: "success",
    statusCode: 200,
    body: "ok",
    timestamp: 0,
    ...(overrides as object),
  } as WorkflowResult;
}

describe("truncateBody (SPEC §7.6)", () => {
  it("does NOT truncate 2xx bodies even when they are very long", () => {
    const longBody = "x".repeat(ERROR_BODY_CHAR_LIMIT * 2);
    const out = truncateBody(
      result({ outcome: "success", statusCode: 200, body: longBody }),
    );
    expect(out).toBe(longBody);
  });

  it("truncates http-error (4xx) bodies past the limit and appends the marker", () => {
    const longBody = "x".repeat(ERROR_BODY_CHAR_LIMIT + 500);
    const out = truncateBody(
      result({ outcome: "http-error", statusCode: 400, body: longBody }),
    );
    expect(out.length).toBe(ERROR_BODY_CHAR_LIMIT + "…(truncated)".length);
    expect(out.endsWith("…(truncated)")).toBe(true);
  });

  it("truncates http-error (5xx) bodies past the limit", () => {
    const longBody = "x".repeat(ERROR_BODY_CHAR_LIMIT + 1);
    const out = truncateBody(
      result({ outcome: "http-error", statusCode: 503, body: longBody }),
    );
    expect(out.endsWith("…(truncated)")).toBe(true);
  });

  it("does NOT truncate http-error bodies that are at or below the limit", () => {
    const exactBody = "x".repeat(ERROR_BODY_CHAR_LIMIT);
    const out = truncateBody(
      result({ outcome: "http-error", statusCode: 500, body: exactBody }),
    );
    expect(out).toBe(exactBody);
  });

  it("does not touch timeout / aborted / network-error bodies", () => {
    const long = "x".repeat(ERROR_BODY_CHAR_LIMIT + 500);
    for (const outcome of ["timeout", "aborted", "network-error"] as const) {
      const out = truncateBody(result({ outcome, body: long }));
      expect(out).toBe(long);
    }
  });
});

describe("addResult (SPEC §6.4 result list)", () => {
  it("prepends a new result so the newest is at the top", () => {
    const list = [result({ workflowId: "old" })];
    const next = addResult(list, result({ workflowId: "new" }));
    expect(next[0]?.workflowId).toBe("new");
    expect(next[1]?.workflowId).toBe("old");
  });

  it("returns a NEW array (doesn't mutate the input)", () => {
    const list = [result({ workflowId: "a" })];
    const next = addResult(list, result({ workflowId: "b" }));
    expect(list).toEqual([result({ workflowId: "a" })]);
    expect(next).not.toBe(list);
  });

  it("caps the list at RESULT_LIST_MAX_LENGTH entries", () => {
    let list: WorkflowResult[] = [];
    for (let i = 0; i < RESULT_LIST_MAX_LENGTH + 3; i += 1) {
      list = addResult(list, result({ workflowId: `wf-${i}` }));
    }
    expect(list.length).toBe(RESULT_LIST_MAX_LENGTH);
    // The oldest (wf-0..wf-2) should have been evicted; the newest
    // (wf-7) is at the top.
    expect(list[0]?.workflowId).toBe(`wf-${RESULT_LIST_MAX_LENGTH + 2}`);
    expect(list[list.length - 1]?.workflowId).toBe(`wf-3`);
  });

  it("evicts the oldest entry when the 6th is pushed", () => {
    let list: WorkflowResult[] = [];
    for (let i = 0; i < RESULT_LIST_MAX_LENGTH; i += 1) {
      list = addResult(list, result({ workflowId: `wf-${i}` }));
    }
    const oldest = list[list.length - 1]?.workflowId;
    list = addResult(list, result({ workflowId: "wf-new" }));
    expect(list.length).toBe(RESULT_LIST_MAX_LENGTH);
    expect(list[0]?.workflowId).toBe("wf-new");
    expect(list.find((r) => r.workflowId === oldest)).toBeUndefined();
  });
});
