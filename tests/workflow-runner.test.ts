import { describe, it, expect, vi } from "vitest";
import {
  runWorkflow,
  WORKFLOW_TIMEOUT_MS,
  ERROR_BODY_CHAR_LIMIT,
} from "@/background/workflow-runner";
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

  it("truncates 4xx/5xx bodies to ERROR_BODY_CHAR_LIMIT per SPEC §7.6", async () => {
    const bigBody = "x".repeat(ERROR_BODY_CHAR_LIMIT + 500);
    const fetchImpl = vi.fn(async () => jsonResponse(bigBody, 503));
    const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
    expect(result.outcome).toBe("http-error");
    expect(result.statusCode).toBe(503);
    expect(result.body.length).toBe(ERROR_BODY_CHAR_LIMIT + "…(truncated)".length);
    expect(result.body.endsWith("…(truncated)")).toBe(true);
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

  it("classifies a DOMException-shaped AbortError as timeout, not network-error", async () => {
    // Build a non-Error abort signal — some runtimes deliver
    // AbortError as a DOMException that may not be `instanceof Error`.
    const abortLike = { name: "AbortError", message: "aborted" };
    const fetchImpl = vi.fn(async () => {
      throw abortLike;
    });
    const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
    expect(result.outcome).toBe("timeout");
  });

  it("keeps the abort timer armed until the response body is fully read", async () => {
    // Slow body: response resolves immediately (headers received) but
    // .text() takes longer than the timeout. The runner must still
    // abort.
    vi.useFakeTimers();
    try {
      let abortBody: () => void = () => {};
      const slowBody = new ReadableStream<Uint8Array>({
        start(controller) {
          abortBody = () => controller.error(new DOMException("aborted", "AbortError"));
        },
      });
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => abortBody());
        return new Response(slowBody, { status: 200 });
      });
      const promise = runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
      await vi.advanceTimersByTimeAsync(WORKFLOW_TIMEOUT_MS + 1);
      const result = await promise;
      expect(result.outcome).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns outcome: \"aborted\" when externalSignal is already aborted before fetch starts", async () => {
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkflow(baseWorkflow, baseVars, {
      fetch: fetchImpl,
      externalSignal: controller.signal,
    });
    expect(result.outcome).toBe("aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns outcome: \"aborted\" when externalSignal fires during fetch", async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const controller = new AbortController();
    const promise = runWorkflow(baseWorkflow, baseVars, {
      fetch: fetchImpl,
      externalSignal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.outcome).toBe("aborted");
  });

  it("clears the abort timer once the body has been fully read", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const fetchImpl = vi.fn(async () => jsonResponse("ok", 200));
      const result = await runWorkflow(baseWorkflow, baseVars, { fetch: fetchImpl });
      expect(result.outcome).toBe("success");
      // The runner installs exactly one setTimeout; clearTimeout must
      // be called exactly once on the success path.
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });
});
