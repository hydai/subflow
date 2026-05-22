import { describe, it, expect } from "vitest";
import { validateWorkflow } from "@/lib/validate-workflow";
import type { Workflow } from "@/lib/types";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Summarize",
    url: "https://example.com/api",
    promptTemplate: "Summarize: {{transcript}}",
    autoRun: false,
    headers: { Authorization: "Bearer abc" },
    ...overrides,
  };
}

describe("validateWorkflow (SPEC §7.4)", () => {
  it("returns no errors for a fully-valid workflow", () => {
    expect(validateWorkflow(workflow())).toEqual([]);
  });

  it("rejects missing name (empty string)", () => {
    const errors = validateWorkflow(workflow({ name: "" }));
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects whitespace-only name", () => {
    const errors = validateWorkflow(workflow({ name: "   " }));
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects http:// URL", () => {
    const errors = validateWorkflow(workflow({ url: "http://example.com/api" }));
    expect(errors.some((e) => e.field === "url" && /https/.test(e.message))).toBe(
      true,
    );
  });

  it("accepts https:// URL", () => {
    const errors = validateWorkflow(workflow({ url: "https://example.com/api" }));
    expect(errors.some((e) => e.field === "url")).toBe(false);
  });

  it("rejects malformed URL (whitespace)", () => {
    const errors = validateWorkflow(workflow({ url: "not a url" }));
    expect(errors.some((e) => e.field === "url")).toBe(true);
  });

  it("rejects empty promptTemplate", () => {
    const errors = validateWorkflow(workflow({ promptTemplate: "" }));
    expect(errors.some((e) => e.field === "promptTemplate")).toBe(true);
  });

  it("rejects whitespace-only promptTemplate", () => {
    const errors = validateWorkflow(workflow({ promptTemplate: "   " }));
    expect(errors.some((e) => e.field === "promptTemplate")).toBe(true);
  });

  it("rejects headers with `Content-Type` (canonical casing)", () => {
    const errors = validateWorkflow(
      workflow({ headers: { "Content-Type": "application/json" } }),
    );
    expect(errors.some((e) => e.field === "headers")).toBe(true);
  });

  it("rejects headers with `content-type` (lower casing)", () => {
    const errors = validateWorkflow(
      workflow({ headers: { "content-type": "application/json" } }),
    );
    expect(errors.some((e) => e.field === "headers")).toBe(true);
  });

  it("rejects headers with `CONTENT-TYPE` (upper casing)", () => {
    const errors = validateWorkflow(
      workflow({ headers: { "CONTENT-TYPE": "application/json" } }),
    );
    expect(errors.some((e) => e.field === "headers")).toBe(true);
  });

  it("accepts headers without a Content-Type key", () => {
    const errors = validateWorkflow(
      workflow({ headers: { Authorization: "Bearer x" } }),
    );
    expect(errors.some((e) => e.field === "headers")).toBe(false);
  });

  it("accumulates multiple errors (does not bail on first)", () => {
    const errors = validateWorkflow(
      workflow({
        name: "",
        url: "http://x",
        promptTemplate: "",
        headers: { "content-type": "application/json" },
      }),
    );
    const fields = errors.map((e) => e.field).sort();
    expect(fields).toEqual(["headers", "name", "promptTemplate", "url"]);
  });
});
