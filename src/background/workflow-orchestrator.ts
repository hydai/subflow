// Per-tab workflow trigger orchestration for SPEC §6.5 + §6.7.
//
// Responsibilities:
//
//   - AutoRun dedup: each `(videoId, workflowId)` fires at most ONCE
//     per tab open. Persists across SPA switches (so a back-navigation
//     to a previously-auto-run video does NOT re-fire), reset only on
//     tab close.
//   - In-flight tracking: every executing workflow registers an
//     AbortController so SPA navigation can abort old-video requests
//     in bulk (§6.7 "舊工作流請求被中止；其回應不顯示").
//   - Manual triggers: no dedup, no client-side rate limit — each
//     button click yields a fresh execution attempt and a fresh
//     AbortController.
//
// The "Refresh subtitle" path does NOT pass through this class:
// per SPEC §6.7 it intentionally does not abort in-flight workflow
// requests. Only SubtitleService.invalidateVideo / .changeVideo see
// that signal, and the only call into this orchestrator that aborts
// is `abortInFlight(tabId)`, which the background's video-changed
// handler dispatches separately.

import { runWorkflow } from "./workflow-runner";
import type { WorkflowRunnerDeps } from "./workflow-runner";
import type { PromptVariables, Workflow, WorkflowResult } from "@/lib/types";

interface TabState {
  // `${videoId}|${workflowId}` for each autoRun that has already
  // fired in this tab. Persists across SPA navigation; clearing
  // happens on tab close (chrome.tabs.onRemoved).
  autoRunFired: Set<string>;
  // AbortControllers for every currently running workflow request
  // in this tab. abortInFlight() aborts them all in one pass.
  inFlight: Set<AbortController>;
}

export interface WorkflowOrchestratorDeps {
  // Overrideable for tests; production callers pass nothing and get
  // the real `runWorkflow` (which itself uses globalThis.fetch).
  runWorkflow?: typeof runWorkflow;
}

export class WorkflowOrchestrator {
  private readonly tabs = new Map<number, TabState>();
  private readonly runner: typeof runWorkflow;

  constructor(deps: WorkflowOrchestratorDeps = {}) {
    this.runner = deps.runWorkflow ?? runWorkflow;
  }

  // Manual trigger: always returns a Promise that resolves to the
  // result. Multiple concurrent calls produce multiple concurrent
  // requests; no dedup, no rate limit (§6.5).
  async runManual(
    tabId: number,
    workflow: Workflow,
    variables: PromptVariables,
  ): Promise<WorkflowResult> {
    return this.execute(tabId, workflow, variables);
  }

  // AutoRun trigger: returns the result Promise on the FIRST call for
  // a (tabId, videoId, workflowId) triple in this tab's open session,
  // or `null` if it has already fired.
  async runAutoRun(
    tabId: number,
    videoId: string,
    workflow: Workflow,
    variables: PromptVariables,
  ): Promise<WorkflowResult | null> {
    const state = this.touch(tabId);
    const key = `${videoId}|${workflow.id}`;
    if (state.autoRunFired.has(key)) return null;
    state.autoRunFired.add(key);
    return this.execute(tabId, workflow, variables);
  }

  // SPA-navigation hook: abort every workflow request currently
  // in-flight in the given tab. The aborted promise resolves with
  // `outcome: "aborted"`, which the caller (background router) MUST
  // suppress from the sidebar's result list per §6.7.
  abortInFlight(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (state === undefined) return;
    for (const controller of state.inFlight) {
      controller.abort();
    }
    state.inFlight.clear();
  }

  // Tab-close cleanup — abort all running workflows for this tab
  // (so a request started just before the tab closed doesn't keep
  // running into the void) and drop the tab's autoRun history.
  forgetTab(tabId: number): void {
    this.abortInFlight(tabId);
    this.tabs.delete(tabId);
  }

  private async execute(
    tabId: number,
    workflow: Workflow,
    variables: PromptVariables,
  ): Promise<WorkflowResult> {
    const state = this.touch(tabId);
    const controller = new AbortController();
    state.inFlight.add(controller);
    const deps: WorkflowRunnerDeps = { externalSignal: controller.signal };
    try {
      return await this.runner(workflow, variables, deps);
    } finally {
      state.inFlight.delete(controller);
    }
  }

  private touch(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (state === undefined) {
      state = { autoRunFired: new Set(), inFlight: new Set() };
      this.tabs.set(tabId, state);
    }
    return state;
  }
}
