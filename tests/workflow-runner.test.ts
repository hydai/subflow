import { describe, it, expect, vi } from "vitest";
import { runWorkflow, WORKFLOW_TIMEOUT_MS } from "@/background/workflow-runner";
import type { PromptVariables, Workflow } from "@/lib/types";

const baseWorkflow: Workflow = {
  id: "wf-1",
  name: "Summarize",
  url: "https://example.com/api",
  promptTemplate: "Summarize: {{transcript}}",
  autoRun: false,
  headers: { Authorization: "Bearer abc" },
};

const baseVars: PromptVariables = {
  transcript: "hello",
  transcript_with_timestamps: "[00:00] hello",
  title: "T",
  video_id: "v1",
  video_url: "https://www.youtube.com/watch?v=v1",
  channel: "c",
  language: "en",
  duration_seconds: 60,
};

function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("runWorkflow (SPEC §6.3 + §7.2)", () => {
  it("returns success on a 2xx response with the full body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"reply":"ok"}', 200));
    const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl, now: () => 100 });
    expect(result.outcome).toBe("success");
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"reply":"ok"}');
    expect(result.workflowId).toBe("wf-1");
    expect(result.timestamp).toBe(100);
    // Sent: POST, headers include workflow.headers + Content-Type,
    // body is JSON.stringify({ prompt: substituted }).
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer abc",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "Summarize: hello" }),
      }),
    );
  });

  it("returns http-error with the body for a 4xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"error":"bad request"}', 400));
    const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
    expect(result.outcome).toBe("http-error");
    expect(result.statusCode).toBe(400);
    expect(result.body).toBe('{"error":"bad request"}');
  });

  it("returns http-error with the body for a 5xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("server exploded", 500));
    const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
    expect(result.outcome).toBe("http-error");
    expect(result.statusCode).toBe(500);
    expect(result.body).toBe("server exploded");
  });

  it("returns timeout when the AbortController fires", async () => {
    // The runner installs an AbortController + timeout. We simulate
    // it by waiting for the signal to abort and then throwing an
    // AbortError-shaped error.
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const err = new DOMException("aborted", "AbortError");
          reject(err);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort);
      });
    });
    vi.useFakeTimers();
    try {
      const promise = runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
      vi.advanceTimersByTime(WORKFLOW_TIMEOUT_MS + 1);
      const result = await promise;
      expect(result.outcome).toBe("timeout");
      expect(result.statusCode).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns network-error when fetch itself throws (e.g. DNS, CORS)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
    expect(result.outcome).toBe("network-error");
    expect(result.body).toContain("Failed to fetch");
    expect(result.statusCode).toBeUndefined();
  });

  it("clears the abort timer on a successful response so it doesn't fire later", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse("ok", 200));
      const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
      expect(result.outcome).toBe("success");
      // If the timer were still pending, advancing past the timeout
      // would have triggered abort — but the fetch has already
      // resolved, so this should be a no-op. We just verify nothing
      // throws.
      vi.advanceTimersByTime(WORKFLOW_TIMEOUT_MS + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
