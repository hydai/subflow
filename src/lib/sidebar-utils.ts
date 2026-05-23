// Pure helpers for the sidebar content (SPEC §6.4 / §7.6).
//
// Extracted from the DOM-bearing sidebar renderer so the eviction
// and truncation rules can be exercised by unit tests and stay
// shared with any future consumer (e.g. an export-to-clipboard
// command).

import type { WorkflowResult } from "./types";

// SPEC §7.6: 4xx / 5xx response bodies displayed in the sidebar are
// truncated to the first 2000 characters with `…(truncated)`
// appended. 2xx bodies are shown in full. Other outcomes (timeout,
// network-error, aborted) carry their own short body text and are
// not subject to truncation.
export const ERROR_BODY_CHAR_LIMIT = 2000;
const TRUNCATION_MARKER = "…(truncated)";

export function truncateBody(result: WorkflowResult): string {
  // SPEC §7.6 narrows truncation to 4xx / 5xx specifically — 3xx
  // redirects also surface as outcome:"http-error" via fetch's
  // Response.ok === false, but their bodies are usually short
  // redirect notices and shouldn't carry the truncation marker.
  // (WorkflowResult.statusCode is typed as `number | undefined`;
  // for outcome:"http-error" the runner always sets it, but check
  // explicitly so the property access is safe.)
  if (result.outcome !== "http-error") return result.body;
  if (result.statusCode === undefined) return result.body;
  if (result.statusCode < 400 || result.statusCode > 599) return result.body;
  if (result.body.length <= ERROR_BODY_CHAR_LIMIT) return result.body;
  return result.body.slice(0, ERROR_BODY_CHAR_LIMIT) + TRUNCATION_MARKER;
}

// SPEC §6.4 result-list semantics: newest entry at the top, capped
// at 5; pushing beyond the cap evicts the oldest. Returns a NEW
// array so callers can use it in a state-immutability pattern
// (e.g. React-style or option-page-style render-from-state).
export const RESULT_LIST_MAX_LENGTH = 5;

export function addResult(
  list: readonly WorkflowResult[],
  next: WorkflowResult,
): WorkflowResult[] {
  const prepended = [next, ...list];
  if (prepended.length <= RESULT_LIST_MAX_LENGTH) return prepended;
  return prepended.slice(0, RESULT_LIST_MAX_LENGTH);
}
