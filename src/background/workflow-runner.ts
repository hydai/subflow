// Workflow HTTP POST runner — implements SPEC §6.3 + §7.2 + §7.6.
//
// Given a (workflow, vars) pair, substitute the prompt template, POST
// `{ prompt: substituted }` as application/json to the workflow URL,
// and turn the resulting HTTP / network / timeout outcome into the
// typed `WorkflowResult` variant the sidebar consumes. The runner
// itself is constructor-injected with its `fetch` dependency so the
// test suite can exercise every branch without the network and without
// touching globals.
//
// SPEC §7.2:
//   - method: POST
//   - headers: workflow.headers + fixed Content-Type: application/json
//     (storage-time validation in #9 / #10 already rejects user-
//     supplied Content-Type, so no collision is possible here)
//   - body: JSON.stringify({ prompt: substituted })
//   - timeout: 60s, enforced by AbortController. The timer must remain
//     armed until the response BODY has been fully read — `fetch`
//     resolves once headers arrive, so a slow / streaming body could
//     otherwise exceed the limit without being aborted.
//   - 2xx → success (body unchanged); 4xx/5xx → http-error with the
//     body truncated to 2000 chars per SPEC §7.6
//   - network failure (DNS, CORS, TLS, reset, etc.) → network-error
//     with the underlying message; statusCode is omitted because no
//     HTTP status is known in that path

import { substitute } from "@/lib/substitute";
import type { PromptVariables, Workflow, WorkflowResult } from "@/lib/types";

export const WORKFLOW_TIMEOUT_MS = 60_000;
// SPEC §7.6: 4xx / 5xx response bodies are displayed truncated to the
// first 2000 characters with `…(truncated)` appended; 2xx bodies are
// shown in full.
export const ERROR_BODY_CHAR_LIMIT = 2000;
const TRUNCATION_MARKER = "…(truncated)";

export interface WorkflowRunnerDeps {
  // Defaults to `globalThis.fetch` for production callers; tests pass
  // a `vi.fn()` fake.
  fetch?: typeof fetch;
  // Defaults to `Date.now`; tests can pin the timestamp.
  now?: () => number;
  // External abort signal. When the caller aborts this signal
  // (SPA navigation, manual cancel, etc.) the in-flight workflow
  // request is cancelled in addition to its own internal 60-second
  // timeout. The result will be classified as `outcome: "aborted"`
  // so callers can distinguish caller-driven cancellation from a
  // timeout fire.
  externalSignal?: AbortSignal;
}

export async function runWorkflow(
  workflow: Workflow,
  variables: PromptVariables,
  deps: WorkflowRunnerDeps = {},
): Promise<WorkflowResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const timestamp = now();

  const prompt = substitute(workflow.promptTemplate, variables);
  const body = JSON.stringify({ prompt });
  // SPEC §7.2: workflow.headers applied as-is, then Content-Type
  // re-stamped. Storage-time validation forbids a user-supplied
  // Content-Type, so there is no collision to resolve here.
  const headers: Record<string, string> = {
    ...workflow.headers,
    "Content-Type": "application/json",
  };

  // Internal controller drives the 60s timeout; external signal can
  // also abort it. We track WHY the abort happened (timeout vs
  // external) with explicit booleans rather than re-reading
  // externalSignal.aborted at catch time, because the timeout AND
  // an external abort can both fire (e.g., timeout aborts, then the
  // SPA-navigation handler also aborts on the next tick). Whoever
  // flips the flag first wins the classification: a real timeout
  // must not be misreported as an external abort.
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WORKFLOW_TIMEOUT_MS);

  // Forward external aborts (e.g. SPA navigation, #16) into our
  // controller, and short-circuit if the signal is already aborted
  // when we start.
  const externalSignal = deps.externalSignal;
  let externalAbortHandler: (() => void) | null = null;
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutHandle);
      externallyAborted = true;
      return abortedResult(workflow, timestamp);
    }
    externalAbortHandler = () => {
      // Only flip if the timeout didn't beat us to it. Once
      // `timedOut === true`, the result classification is locked.
      if (!timedOut) {
        externallyAborted = true;
        // Stop the timer too — once external abort has won, leaving
        // a stale timeout armed could still flip `timedOut` later
        // (e.g. fetch hasn't yet rejected) and misreport the result
        // as a timeout.
        clearTimeout(timeoutHandle);
      }
      controller.abort();
    };
    externalSignal.addEventListener("abort", externalAbortHandler);
  }
  const cleanupExternal = (): void => {
    if (externalSignal !== undefined && externalAbortHandler !== null) {
      externalSignal.removeEventListener("abort", externalAbortHandler);
    }
  };

  let response: Response;
  try {
    response = await fetchImpl(workflow.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    cleanupExternal();
    if (isAbortError(err)) {
      // Three classifications, in priority order:
      //   1. Internal timeout fired → "timeout" (wins even if an
      //      external abort also arrives — once the timer fires,
      //      the request DID time out).
      //   2. External signal aborted but no timeout → "aborted".
      //   3. Neither flag set (e.g. a runtime-injected AbortError
      //      from a tab unload, or a test that throws an
      //      AbortError-shaped object directly) → "timeout".
      //      This matches the runner's pre-#16 behavior: any
      //      AbortError of unknown origin was historically
      //      treated as the timeout path.
      if (timedOut) return timeoutResult(workflow, timestamp);
      if (externallyAborted) return abortedResult(workflow, timestamp);
      return timeoutResult(workflow, timestamp);
    }
    return networkErrorResult(workflow, timestamp, err);
  }

  // Keep the timer ARMED until we finish reading the body — fetch's
  // promise resolved on headers, so a slow body still needs the abort
  // safety net. We only clear after text() resolves or rejects.
  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch (err) {
    clearTimeout(timeoutHandle);
    cleanupExternal();
    if (isAbortError(err)) {
      // Three classifications, in priority order:
      //   1. Internal timeout fired → "timeout" (wins even if an
      //      external abort also arrives — once the timer fires,
      //      the request DID time out).
      //   2. External signal aborted but no timeout → "aborted".
      //   3. Neither flag set (e.g. a runtime-injected AbortError
      //      from a tab unload, or a test that throws an
      //      AbortError-shaped object directly) → "timeout".
      //      This matches the runner's pre-#16 behavior: any
      //      AbortError of unknown origin was historically
      //      treated as the timeout path.
      if (timedOut) return timeoutResult(workflow, timestamp);
      if (externallyAborted) return abortedResult(workflow, timestamp);
      return timeoutResult(workflow, timestamp);
    }
    return networkErrorResult(workflow, timestamp, err);
  }
  clearTimeout(timeoutHandle);
  cleanupExternal();

  if (response.ok) {
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      outcome: "success",
      statusCode: response.status,
      body: responseBody,
      timestamp,
    };
  }
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    outcome: "http-error",
    statusCode: response.status,
    body: truncate(responseBody, ERROR_BODY_CHAR_LIMIT),
    timestamp,
  };
}

function timeoutResult(workflow: Workflow, timestamp: number): WorkflowResult {
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    outcome: "timeout",
    body: `Request timed out after ${WORKFLOW_TIMEOUT_MS / 1000}s`,
    timestamp,
  };
}

function abortedResult(workflow: Workflow, timestamp: number): WorkflowResult {
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    outcome: "aborted",
    body: "Request aborted (SPA navigation or caller cancel).",
    timestamp,
  };
}

function networkErrorResult(
  workflow: Workflow,
  timestamp: number,
  err: unknown,
): WorkflowResult {
  // `statusCode` is intentionally omitted — no HTTP status is known
  // on this path, and the shared type documents statusCode as
  // outcome-conditional.
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    outcome: "network-error",
    body: err instanceof Error ? err.message : String(err),
    timestamp,
  };
}

// AbortError comes in two flavours depending on the runtime:
//   - browsers / Node 18+: a `DOMException` whose `name` is
//     `"AbortError"` (DOMException extends Error, so `instanceof
//     Error` is true in practice — but we don't rely on it)
//   - other runtimes: an `Error` subclass whose `name` is
//     `"AbortError"`
// Both share the canonical `name` property, so we check that directly.
function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  return (err as { name?: unknown }).name === "AbortError";
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATION_MARKER;
}
