import { describe, it, expect, vi } from "vitest";
import { WorkflowOrchestrator } from "@/background/workflow-orchestrator";
import type { PromptVariables, Workflow, WorkflowResult } from "@/lib/types";

const workflowA: Workflow = {
  id: "wf-a",
  name: "A",
  url: "https://example.com/a",
  promptTemplate: "{{transcript}}",
  autoRun: true,
  headers: {},
};
const workflowB: Workflow = {
  id: "wf-b",
  name: "B",
  url: "https://example.com/b",
  promptTemplate: "{{transcript}}",
  autoRun: true,
  headers: {},
};
const vars: PromptVariables = {
  transcript: "hi",
  transcript_with_timestamps: "[00:00] hi",
  title: "t",
  video_id: "abc",
  video_url: "https://www.youtube.com/watch?v=abc",
  channel: "c",
  language: "en",
  duration_seconds: 10,
};

function okResult(workflow: Workflow): WorkflowResult {
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    outcome: "success",
    statusCode: 200,
    body: "ok",
    timestamp: 0,
  };
}

describe("WorkflowOrchestrator (SPEC §6.5 + §6.7)", () => {
  it("manual triggers do NOT dedup — every call runs", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runManual(1, workflowA, vars);
    await orch.runManual(1, workflowA, vars);
    await orch.runManual(1, workflowA, vars);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("autoRun fires exactly once per (tab, video, workflow)", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    const first = await orch.runAutoRun(1, "abc", workflowA, vars);
    const second = await orch.runAutoRun(1, "abc", workflowA, vars);
    expect(first?.outcome).toBe("success");
    expect(second).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("autoRun isolation: a different workflow on the same video still fires", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runAutoRun(1, "abc", workflowA, vars);
    await orch.runAutoRun(1, "abc", workflowB, vars);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("autoRun isolation: same workflow, different video still fires", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runAutoRun(1, "abc", workflowA, vars);
    await orch.runAutoRun(1, "def", workflowA, vars);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("autoRun isolation: same (video, workflow) in a different tab still fires", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runAutoRun(1, "abc", workflowA, vars);
    await orch.runAutoRun(2, "abc", workflowA, vars);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("autoRun history persists across SPA navigations (going back doesn't re-fire)", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runAutoRun(1, "abc", workflowA, vars);
    // SPA navigation triggers abortInFlight, but autoRunFired persists.
    orch.abortInFlight(1);
    await orch.runAutoRun(1, "def", workflowA, vars);
    // Back-navigate to abc.
    orch.abortInFlight(1);
    const reFire = await orch.runAutoRun(1, "abc", workflowA, vars);
    expect(reFire).toBeNull();
    expect(runner).toHaveBeenCalledTimes(2); // abc + def, not abc again
  });

  it("forgetTab clears autoRun history (tab close re-arms autoRun)", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runAutoRun(1, "abc", workflowA, vars);
    orch.forgetTab(1);
    await orch.runAutoRun(1, "abc", workflowA, vars);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("abortInFlight aborts running workflows; the runner returns outcome: 'aborted'", async () => {
    // The fake runner observes its `externalSignal` and resolves
    // with outcome:'aborted' once aborted — that's what the real
    // runWorkflow does too.
    const runner = vi.fn(async (wf, _vars, deps) => {
      return new Promise<WorkflowResult>((resolve) => {
        const signal = deps?.externalSignal;
        signal?.addEventListener("abort", () => {
          resolve({
            workflowId: wf.id,
            workflowName: wf.name,
            outcome: "aborted",
            body: "Request aborted.",
            timestamp: 0,
          });
        });
      });
    });
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    const running = orch.runManual(1, workflowA, vars);
    orch.abortInFlight(1);
    const result = await running;
    expect(result.outcome).toBe("aborted");
  });

  it("abortInFlight only affects the targeted tab", async () => {
    const runner = vi.fn(async (wf, _vars, deps) => {
      return new Promise<WorkflowResult>((resolve) => {
        deps?.externalSignal?.addEventListener("abort", () => {
          resolve({
            workflowId: wf.id,
            workflowName: wf.name,
            outcome: "aborted",
            body: "x",
            timestamp: 0,
          });
        });
        // Otherwise resolve after a microtask to keep the test fast.
        setTimeout(() => resolve(okResult(wf)), 0);
      });
    });
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    const a = orch.runManual(1, workflowA, vars);
    const b = orch.runManual(2, workflowA, vars);
    orch.abortInFlight(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe("aborted");
    expect(rb.outcome).toBe("success");
  });

  it("inflight set is cleared after the workflow finishes", async () => {
    const runner = vi.fn(async (wf) => okResult(wf));
    const orch = new WorkflowOrchestrator({ runWorkflow: runner });
    await orch.runManual(1, workflowA, vars);
    // After completion, abortInFlight should be a no-op (the
    // controller is unregistered).
    expect(() => orch.abortInFlight(1)).not.toThrow();
  });
});
