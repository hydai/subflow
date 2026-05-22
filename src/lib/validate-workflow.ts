// Pure validation for the options-page workflow editor (SPEC §7.4).
//
// `validateWorkflow` is intentionally decoupled from the DOM so the
// rules can be exercised by unit tests and reused by anywhere else
// that needs to gate-keep a Workflow value before passing it to
// `setWorkflows` (#8) — e.g. a future bulk-import path.
//
// SPEC §7.4 enumerates the rules:
//   - id, name, url, promptTemplate, autoRun, headers all required
//   - name + promptTemplate non-empty strings
//   - url must use the `https:` scheme on a parseable URL (so
//     "http://", "ftp://...", or "https:// evil\n" all reject)
//   - headers MUST NOT contain a `Content-Type` key, case-insensitive
//     — the runner stamps it as application/json
//
// Errors are returned as a list (not thrown) so the UI can show all
// problems at once instead of one-at-a-time.

import type { Workflow } from "./types";

// `field` identifies WHICH input the inline-error message should
// attach to (SPEC §7.6 requires the error to live next to the
// offending field). UI code keys an element ref off the field name.
export type WorkflowValidationField =
  | "name"
  | "url"
  | "promptTemplate"
  | "headers";

export interface WorkflowValidationError {
  field: WorkflowValidationField;
  message: string;
}

export function validateWorkflow(workflow: Workflow): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];

  if (workflow.name.trim().length === 0) {
    errors.push({ field: "name", message: "Name is required." });
  }

  if (workflow.url.length === 0) {
    errors.push({ field: "url", message: "URL is required." });
  } else {
    const parsed = safeParseUrl(workflow.url);
    if (parsed === null) {
      errors.push({ field: "url", message: "URL must be a valid URL." });
    } else if (parsed.protocol !== "https:") {
      errors.push({
        field: "url",
        message: "URL must use the https:// scheme.",
      });
    } else if (parsed.hostname.length === 0) {
      errors.push({ field: "url", message: "URL must include a hostname." });
    }
  }

  if (workflow.promptTemplate.trim().length === 0) {
    errors.push({
      field: "promptTemplate",
      message: "Prompt template is required.",
    });
  }

  // Case-insensitive `Content-Type` rejection per SPEC §7.4. The
  // error message is the verbatim string the SPEC specifies, so the
  // UI copy and SPEC conformance audit can't drift.
  const contentTypeKey = Object.keys(workflow.headers).find(
    (key) => key.toLowerCase() === "content-type",
  );
  if (contentTypeKey !== undefined) {
    errors.push({
      field: "headers",
      message:
        "`Content-Type` 由系統固定為 `application/json`，請從 headers 移除此鍵",
    });
  }

  return errors;
}

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
