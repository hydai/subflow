// Workflow HTTP POST runner — implements SPEC §6.3 + §7.2.
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
//   - timeout: 60s, enforced by AbortController so the promise rejects
//     with an AbortError that we surface as outcome: "timeout"
//   - 2xx → success (body unchanged); 4xx/5xx → http-error (body
//     truncation is the sidebar's responsibility per #18)
//   - network failure (DNS, CORS, TLS, reset, etc.) → network-error
//     with the underlying message

import { substitute } from "@/lib/substitute";
import type { PromptVariables, Workflow, WorkflowResult } from "@/lib/types";

export const WORKFLOW_TIMEOUT_MS = 60_000;

export interface WorkflowRunnerDeps {
  // Defaults to `globalThis.fetch` for production callers; tests pass
  // a `vi.fn()` fake.
  fetch?: typeof fetch;
  // Defaults to `Date.now`; tests can pin the timestamp.
  now?: () => number;
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

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), WORKFLOW_TIMEOUT_MS);

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
    if (isAbortError(err)) {
      return {
        workflowId: workflow.id,
        workflowName: workflow.name,
        outcome: "timeout",
        body: `Request timed out after ${WORKFLOW_TIMEOUT_MS / 1000}s`,
        timestamp,
      };
    }
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      outcome: "network-error",
      body: err instanceof Error ? err.message : String(err),
      timestamp,
    };
  }
  clearTimeout(timeoutHandle);

  // Reading the body can also time out / abort in theory; we keep it
  // simple and let any throw fall through to network-error.
  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch (err) {
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      outcome: "network-error",
      statusCode: response.status,
      body: err instanceof Error ? err.message : String(err),
      timestamp,
    };
  }

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
    body: responseBody,
    timestamp,
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
