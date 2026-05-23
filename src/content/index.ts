// Subflow content script entry (isolated world).
//
// Two responsibilities live here:
//
//   1. Bridge specific `window.postMessage` envelopes from the
//      main-world script (#4) into chrome.runtime.sendMessage, since
//      the main world has no access to chrome.* APIs.
//
//   2. SPEC §6.4 sidebar lifecycle (#11): inject a Shadow-DOM-isolated
//      root element when the page is a YouTube watch URL, remove it
//      when the user navigates elsewhere, and on SPA navigation to a
//      different videoId notify the background so it can clean up
//      cache entries that no longer belong.
//
// content.js is loaded by Chrome as a classic script (the
// `content_scripts` entry in manifest.json does not set `"type":
// "module"`), so the emitted bundle must contain no ESM module syntax.
// We deliberately keep the file import-graph tiny so Rollup inlines
// everything into a single self-contained bundle: parseWatchPageUrl is
// the only consumer of @/lib/watch-page, so it's inlined; no message-
// tag constants are imported (the whitelist is duplicated inline and
// kept in sync by tests/content-bridge.test.ts).

import { parseWatchPageUrl } from "@/lib/watch-page";
import { addResult, truncateBody } from "@/lib/sidebar-utils";
import type { SubtitleResult, Workflow, WorkflowResult } from "@/lib/types";

const PLAYER_DATA_TAG = "subflow:player-data-extracted";
const SIDEBAR_ROOT_ID = "subflow-sidebar-root";

function isPlayerDataPayload(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== PLAYER_DATA_TAG) return false;
  if (typeof v.href !== "string") return false;
  const result = v.result;
  if (result === null || typeof result !== "object") return false;
  return typeof (result as { ok?: unknown }).ok === "boolean";
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (data === null || typeof data !== "object") return;
  const candidate = data as { type?: unknown };
  if (typeof candidate.type !== "string") return;

  if (candidate.type === PLAYER_DATA_TAG) {
    if (!isPlayerDataPayload(data)) return;
    const d = data as { href: string; result: unknown };
    void chrome.runtime.sendMessage({
      type: PLAYER_DATA_TAG,
      href: d.href,
      result: d.result,
    });
    return;
  }
});

// --------------------------------------------------------------------
// Sidebar lifecycle (#11)
// --------------------------------------------------------------------

// Module-scoped: survives `yt-navigate-finish` event fires so we can
// distinguish "first injection on this page" from "SPA-switched to a
// different video".
//
// `lastVideoId` persists ACROSS unmount events. Leaving /watch and
// later coming back to a different video is semantically the same as
// SPA-navigating from videoA → videoB: the background still needs a
// `subflow:video-changed` so SubtitleService.changeVideo can prune the
// old video's cache entries. Resetting on unmount would suppress that
// message and let stale cache accumulate across navigation cycles.
let lastVideoId: string | null = null;
let sidebarRoot: HTMLElement | null = null;

function syncSidebar(): void {
  const info = parseWatchPageUrl(window.location.href);
  if (info === null) {
    // Off the watch route — remove the sidebar but keep `lastVideoId`
    // so a return to /watch with a different id still triggers
    // video-changed.
    if (sidebarRoot !== null) {
      sidebarRoot.remove();
      sidebarRoot = null;
      sidebarShadow = null;
    }
    return;
  }

  if (sidebarRoot === null) {
    const { host, shadow } = createSidebarRoot();
    sidebarRoot = host;
    sidebarShadow = shadow;
    document.body.appendChild(sidebarRoot);
    void renderSidebar(sidebarShadow, info.videoId);
  } else if (sidebarState !== null && sidebarState.videoId !== info.videoId) {
    void renderSidebar(sidebarShadow, info.videoId);
  }

  if (info.videoId !== lastVideoId) {
    const isInitialObservation = lastVideoId === null;
    lastVideoId = info.videoId;

    if (!isInitialObservation) {
      // SPA navigation between two videos. Tell the background so
      // SubtitleService.changeVideo (#7) can prune cache entries for
      // the previous video and reset its playerData. Suppressed on
      // the very FIRST observation in the tab so that freshly-
      // extracted player data from the main-world script's initial
      // run can't be wiped by a racing changeVideo if the two
      // messages cross — SubtitleService.changeVideo is now also
      // idempotent on matching videoIds as a belt-and-suspenders.
      void chrome.runtime.sendMessage({
        type: "subflow:video-changed",
        videoId: info.videoId,
      });
    }

    // Re-extraction request runs on EVERY videoId change, including
    // the first observation. Two reasons:
    //   - the tab could have loaded on a non-watch URL where the
    //     main-world script's document_idle run bailed early; SPA
    //     navigation to the first /watch then has no player data
    //     until we ask for one.
    //   - SPA navigation between two watch URLs never re-injects the
    //     main-world script, but ytInitialPlayerResponse on the page
    //     is updated for the new video. The re-extraction picks up
    //     the new value.
    window.postMessage(
      { type: "subflow:request-reextraction" },
      window.location.origin,
    );
  }
}

// Closed-mode ShadowRoot reference. With `mode: "closed"`,
// `host.shadowRoot` returns null to EVERY caller — including this
// module — so we must capture the value returned by attachShadow
// ourselves. #12's renderer reads this via the renderSidebar() stub
// below.
let sidebarShadow: ShadowRoot | null = null;

interface SidebarRoot {
  host: HTMLElement;
  shadow: ShadowRoot;
}

function createSidebarRoot(): SidebarRoot {
  const host = document.createElement("div");
  host.id = SIDEBAR_ROOT_ID;
  // `mode: "closed"` keeps the shadow root invisible to page scripts:
  // they cannot reach into `subflow-sidebar-root.shadowRoot` (it's
  // null) to read user-typed workflow names, trigger button clicks,
  // or scrape rendered AI responses.
  const shadow = host.attachShadow({ mode: "closed" });
  // Position the host fixed at the top-right corner — actual UI lands
  // in #12 once it has tests.
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.right = "0";
  host.style.zIndex = "2147483647";
  return { host, shadow };
}

// Per-mount sidebar state. The renderer is re-invoked on every
// videoId change so we keep the state object alive at module scope
// and re-paint into the same shadow root rather than wiping the
// tree on every result.
interface SidebarState {
  // Workflows loaded from chrome.storage.local at first mount. SPEC
  // §6.8 says options-page edits do NOT push live; new workflows
  // appear on the next watch-page visit. We honour that by reading
  // once at mount and not subscribing to chrome.storage.onChanged.
  workflows: Workflow[];
  // Last known subtitle result for the current video. `null` means
  // "no subtitle data has reached us yet".
  subtitle: SubtitleResult | null;
  // Newest first, capped at 5 (SPEC §6.4 result list).
  results: WorkflowResult[];
  // Pending workflow requests indexed by requestId so the result
  // handler can match the response to its initiating click.
  pendingRequests: Map<string, { workflow: Workflow; startedAt: number }>;
  // videoId scope for the current sidebar instance. Reset on every
  // SPA navigation.
  videoId: string;
}

let sidebarState: SidebarState | null = null;
// Bumped on every renderSidebar call. Captured by the async
// initializer so a late-arriving setup for an old video can't
// overwrite the sidebarState that a newer SPA navigation already
// installed.
let renderEpoch = 0;

async function renderSidebar(
  shadow: ShadowRoot | null,
  videoId: string,
): Promise<void> {
  if (shadow === null) return;
  const myEpoch = (renderEpoch += 1);
  // Install a minimal sync sidebarState immediately so the
  // chrome.runtime.onMessage listener can sanity-check incoming
  // pushes (which arrive without waiting for loadWorkflows) — and
  // crucially so any subtitle / workflow result push that arrives
  // DURING the workflows-load await is captured rather than lost.
  sidebarState = {
    workflows: [],
    subtitle: null,
    results: [],
    pendingRequests: new Map(),
    videoId,
  };
  paintSidebar(shadow, sidebarState);
  const workflows = await loadWorkflows();
  if (renderEpoch !== myEpoch) {
    // A newer SPA navigation already started rendering; bail so we
    // don't overwrite the newer videoId's state.
    return;
  }
  // Preserve any subtitle / results / pendingRequests that landed
  // during the await. Only overwrite workflows.
  if (sidebarState !== null && sidebarState.videoId === videoId) {
    sidebarState.workflows = workflows;
  } else {
    sidebarState = {
      workflows,
      subtitle: null,
      results: [],
      pendingRequests: new Map(),
      videoId,
    };
  }
  paintSidebar(shadow, sidebarState);
  void requestSubtitle(videoId, shadow, myEpoch);
}

async function requestSubtitle(
  videoId: string,
  shadow: ShadowRoot,
  epoch: number,
): Promise<void> {
  // The background owns the subtitle fetch (#7). Pull language
  // priority from chrome.storage.local — the sidebar already loaded
  // workflows, but languagePriority lives on the preferences key.
  let languagePriority: string[] = [];
  try {
    const items = await new Promise<Record<string, unknown>>((resolve, reject) => {
      chrome.storage.local.get(["preferences"], (got) => {
        const last = chrome.runtime.lastError;
        if (last !== undefined && last !== null) {
          reject(new Error(last.message ?? "storage.get failed"));
          return;
        }
        resolve(got ?? {});
      });
    });
    const prefs = items.preferences;
    if (prefs !== null && typeof prefs === "object") {
      const langs = (prefs as { languagePriority?: unknown }).languagePriority;
      if (Array.isArray(langs)) {
        languagePriority = langs.filter((s) => typeof s === "string") as string[];
      }
    }
  } catch {
    /* fall through; missing-language-priority status will surface */
  }
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "subflow:request-subtitle",
      videoId,
      languagePriority,
    })) as { videoId?: string; result?: SubtitleResult } | undefined;
    if (response === undefined) return;
    if (renderEpoch !== epoch) return;
    if (sidebarState === null) return;
    if (response.videoId !== sidebarState.videoId) return;
    if (response.result !== undefined) {
      sidebarState.subtitle = response.result;
      paintSidebar(shadow, sidebarState);
    }
  } catch {
    // Background unreachable (service worker reload in progress).
    // The status stays "Loading…"; user can hit Refresh subtitle
    // to retry.
  }
}

async function loadWorkflows(): Promise<Workflow[]> {
  // Inline rather than depending on @/lib/storage so the classic
  // script doesn't share a runtime import with background. SPEC
  // §6.4 lets us load once at mount and not subscribe to changes.
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["workflows"], (items) => {
        const last = chrome.runtime.lastError;
        if (last !== undefined && last !== null) {
          resolve([]);
          return;
        }
        const raw = items?.workflows;
        if (!Array.isArray(raw)) {
          resolve([]);
          return;
        }
        resolve(raw as Workflow[]);
      });
    } catch {
      resolve([]);
    }
  });
}

function paintSidebar(shadow: ShadowRoot, state: SidebarState): void {
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = SIDEBAR_CSS;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "subflow-root";

  const header = document.createElement("header");
  header.className = "subflow-header";
  header.textContent = "Subflow";
  root.appendChild(header);

  root.appendChild(renderSubtitleStatus(state));
  root.appendChild(renderWorkflowButtons(state, shadow));
  root.appendChild(renderResultList(state));
  root.appendChild(renderRefreshButton(state));

  shadow.appendChild(root);
}

function renderSubtitleStatus(state: SidebarState): HTMLElement {
  const section = document.createElement("section");
  section.className = "subflow-status";
  const heading = document.createElement("h3");
  heading.textContent = "Subtitle";
  section.appendChild(heading);
  const status = document.createElement("p");
  status.className = "subflow-status-text";
  if (state.subtitle === null) {
    status.textContent = "Loading…";
  } else if (state.subtitle.status === "ok") {
    status.textContent = `Loaded (${state.subtitle.language})`;
  } else {
    status.textContent = subtitleErrorMessage(state.subtitle);
    status.classList.add("error");
  }
  section.appendChild(status);
  return section;
}

function subtitleErrorMessage(result: SubtitleResult): string {
  if (result.status === "ok") return "";
  // SPEC §6.6 maps each status to a user-facing message. The full
  // copy lives in #17; this is a placeholder that names the failure
  // and surfaces the optional diagnostic if one was attached.
  const detail = "message" in result && result.message !== undefined
    ? `: ${result.message}`
    : "";
  return `Subtitle unavailable (${result.status})${detail}.`;
}

function renderWorkflowButtons(
  state: SidebarState,
  shadow: ShadowRoot,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "subflow-workflows";
  const heading = document.createElement("h3");
  heading.textContent = "Workflows";
  section.appendChild(heading);

  // Only manual workflows appear in the button list (SPEC §6.4).
  // autoRun workflows fire automatically and surface results in
  // the result list without a button.
  const manualWorkflows = state.workflows.filter((w) => w.autoRun === false);
  if (manualWorkflows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "subflow-empty";
    empty.textContent =
      "No manual workflows. Add one on the Subflow options page.";
    section.appendChild(empty);
    return section;
  }

  const row = document.createElement("div");
  row.className = "subflow-button-row";
  for (const workflow of manualWorkflows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "subflow-workflow-button";
    button.textContent = workflow.name;
    button.addEventListener("click", () => {
      void triggerWorkflow(workflow, shadow);
    });
    row.appendChild(button);
  }
  section.appendChild(row);
  return section;
}

function renderResultList(state: SidebarState): HTMLElement {
  const section = document.createElement("section");
  section.className = "subflow-results";
  const heading = document.createElement("h3");
  heading.textContent = "Recent results";
  section.appendChild(heading);

  if (state.results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "subflow-empty";
    empty.textContent = "No results yet. Click a workflow above to start.";
    section.appendChild(empty);
    return section;
  }

  const list = document.createElement("ol");
  list.className = "subflow-result-list";
  for (const result of state.results) {
    list.appendChild(renderResultEntry(result));
  }
  section.appendChild(list);
  return section;
}

function renderResultEntry(result: WorkflowResult): HTMLElement {
  const item = document.createElement("li");
  item.className = "subflow-result";
  item.classList.add(`outcome-${result.outcome}`);

  const meta = document.createElement("div");
  meta.className = "subflow-result-meta";
  const name = document.createElement("strong");
  name.textContent = result.workflowName;
  const time = document.createElement("time");
  const date = new Date(result.timestamp);
  time.dateTime = date.toISOString();
  time.textContent = formatTime(date);
  meta.append(name, document.createTextNode(" — "), time);
  item.appendChild(meta);

  const outcomeLabel = document.createElement("p");
  outcomeLabel.className = "subflow-result-outcome";
  outcomeLabel.textContent = formatOutcomeLabel(result);
  item.appendChild(outcomeLabel);

  const body = document.createElement("pre");
  body.className = "subflow-result-body";
  // SPEC §6.4: results render as PLAIN TEXT — `textContent` rather
  // than innerHTML so any HTML / script in the AI response or HTTP
  // error body is not executed. `white-space: pre-wrap` (in the
  // stylesheet) preserves newlines and wraps long lines.
  body.textContent = truncateBody(result);
  item.appendChild(body);

  return item;
}

function formatOutcomeLabel(result: WorkflowResult): string {
  switch (result.outcome) {
    case "success":
      return `Success (HTTP ${result.statusCode})`;
    case "http-error":
      return `HTTP ${result.statusCode}`;
    case "timeout":
      return "Timed out";
    case "aborted":
      return "Aborted";
    case "network-error":
      return "Network error";
    case "precondition-failed":
      return "Waiting for subtitle";
  }
}

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderRefreshButton(state: SidebarState): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "subflow-refresh";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "subflow-refresh-button";
  button.textContent = "Refresh subtitle";
  button.addEventListener("click", () => {
    void chrome.runtime.sendMessage({
      type: "subflow:refetch-subtitle",
      videoId: state.videoId,
    });
  });
  wrap.appendChild(button);
  return wrap;
}

async function triggerWorkflow(
  workflow: Workflow,
  shadow: ShadowRoot,
): Promise<void> {
  if (sidebarState === null) return;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sidebarState.pendingRequests.set(requestId, {
    workflow,
    startedAt: Date.now(),
  });
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "subflow:execute-workflow",
      workflow,
      // The background owns the prompt-variable substitution. Sending
      // a placeholder variables block lets the background validate
      // the message envelope; the actual variables are filled in
      // by the background from its own SubtitleService state.
      variables: makePlaceholderVariables(sidebarState.videoId),
      trigger: "manual",
      videoId: sidebarState.videoId,
      requestId,
    })) as unknown;
    // Guard against background unreachable (service worker reload
    // mid-call): sendMessage resolves to undefined, which would
    // make handleWorkflowResponse crash on .videoId access.
    if (!isWorkflowResponse(response)) {
      handleWorkflowResponse(
        {
          videoId: sidebarState.videoId,
          requestId,
          result: {
            workflowId: workflow.id,
            workflowName: workflow.name,
            outcome: "network-error",
            body:
              "Background did not respond. Reload the extension at chrome://extensions/ and try again.",
            timestamp: Date.now(),
          },
          suppressed: false,
        },
        shadow,
      );
      return;
    }
    handleWorkflowResponse(response, shadow);
  } catch (err) {
    handleWorkflowResponse(
      {
        videoId: sidebarState.videoId,
        requestId,
        result: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          outcome: "network-error",
          body: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        },
        suppressed: false,
      },
      shadow,
    );
  }
}

function makePlaceholderVariables(videoId: string): import("@/lib/types").PromptVariables {
  // The background's execute-workflow handler OVERRIDES whatever
  // PromptVariables we pass here with the authoritative values it
  // builds from its SubtitleService cache. This placeholder exists
  // ONLY to satisfy the message-envelope validator's shape check;
  // the values are immediately discarded background-side. Include
  // every field of PromptVariables explicitly (even the
  // string-or-undefined ones) so future tightening of the validator
  // can't reject this shape without us noticing at compile time.
  return {
    transcript: "",
    transcript_with_timestamps: "",
    title: undefined,
    channel: undefined,
    video_id: videoId,
    video_url: `https://www.youtube.com/watch?v=${videoId}`,
    language: "",
    duration_seconds: undefined,
  };
}

interface WorkflowResponse {
  videoId: string;
  requestId: string;
  result: WorkflowResult | null;
  suppressed?: boolean;
}

function isWorkflowResponse(value: unknown): value is WorkflowResponse {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.videoId !== "string") return false;
  if (typeof v.requestId !== "string") return false;
  if (v.result === null) return true;
  if (v.result === undefined || typeof v.result !== "object") return false;
  const r = v.result as Record<string, unknown>;
  return (
    typeof r.workflowId === "string" &&
    typeof r.workflowName === "string" &&
    typeof r.outcome === "string" &&
    typeof r.body === "string" &&
    typeof r.timestamp === "number"
  );
}

function isSubtitleResultLike(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.status !== "string") return false;
  // Either ok with transcript fields, or one of the known failure
  // statuses with an optional message.
  if (v.status === "ok") {
    return (
      typeof v.transcript === "string" &&
      typeof v.transcriptWithTimestamps === "string" &&
      typeof v.language === "string"
    );
  }
  // Failure: status is some known non-ok variant; message is
  // optional but if present must be a string.
  if (v.message !== undefined && typeof v.message !== "string") return false;
  return true;
}

function handleWorkflowResponse(
  response: WorkflowResponse,
  shadow: ShadowRoot,
): void {
  if (sidebarState === null) return;
  if (response.videoId !== sidebarState.videoId) return;
  sidebarState.pendingRequests.delete(response.requestId);
  if (response.suppressed === true) return;
  if (response.result === null) return;
  sidebarState.results = addResult(sidebarState.results, response.result);
  paintSidebar(shadow, sidebarState);
}

// Listen for unsolicited push messages from the background (e.g.
// autoRun results, subtitle availability updates that the sidebar
// should reflect even when it didn't initiate the request).
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (sidebarState === null || sidebarShadow === null) return undefined;
  if (message === null || typeof message !== "object") return undefined;
  const msg = message as { type?: unknown };
  if (msg.type === "subflow:subtitle-result") {
    const m = message as { videoId?: unknown; result?: unknown };
    if (m.videoId !== sidebarState.videoId) return undefined;
    if (!isSubtitleResultLike(m.result)) return undefined;
    sidebarState.subtitle = m.result as SubtitleResult;
    paintSidebar(sidebarShadow, sidebarState);
  } else if (msg.type === "subflow:workflow-result") {
    if (isWorkflowResponse(message)) {
      handleWorkflowResponse(message, sidebarShadow);
    }
  }
  return undefined;
});

const SIDEBAR_CSS = `
  :host {
    all: initial;
  }
  .subflow-root {
    box-sizing: border-box;
    width: 320px;
    max-height: 80vh;
    overflow-y: auto;
    margin: 1rem;
    padding: 0.75rem;
    background: #ffffff;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    .subflow-root {
      background: #0f172a;
      color: #e5e7eb;
      border-color: #374151;
    }
  }
  h3 {
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0 0 0.4rem;
    color: inherit;
  }
  .subflow-header {
    font-weight: 700;
    font-size: 1em;
    margin-bottom: 0.75rem;
    color: #2563eb;
  }
  .subflow-empty {
    margin: 0;
    color: #6b7280;
    font-style: italic;
    font-size: 0.85em;
  }
  .subflow-status-text {
    margin: 0;
  }
  .subflow-status-text.error {
    color: #b91c1c;
  }
  .subflow-button-row {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 0.5rem;
    padding-bottom: 0.25rem;
  }
  .subflow-workflow-button {
    flex: 0 0 auto;
    white-space: nowrap;
    padding: 0.35rem 0.75rem;
    font: inherit;
    color: inherit;
    background: rgba(37, 99, 235, 0.08);
    border: 1px solid #2563eb;
    border-radius: 999px;
    cursor: pointer;
  }
  .subflow-workflow-button:hover {
    background: rgba(37, 99, 235, 0.18);
  }
  section + section {
    margin-top: 0.85rem;
  }
  .subflow-result-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .subflow-result {
    border: 1px solid #d1d5db;
    border-radius: 0.35rem;
    padding: 0.5rem 0.6rem;
    background: rgba(127, 127, 127, 0.04);
  }
  .subflow-result.outcome-http-error,
  .subflow-result.outcome-network-error,
  .subflow-result.outcome-timeout {
    border-color: #fca5a5;
    background: rgba(248, 113, 113, 0.08);
  }
  .subflow-result-meta {
    font-size: 0.85em;
    color: #6b7280;
    margin-bottom: 0.25rem;
  }
  .subflow-result-outcome {
    margin: 0 0 0.3rem;
    font-size: 0.85em;
    font-weight: 600;
  }
  .subflow-result-body {
    margin: 0;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 12rem;
    overflow-y: auto;
  }
  .subflow-refresh-button {
    margin-top: 0.4rem;
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
  }
  .subflow-refresh-button:hover {
    background: rgba(127, 127, 127, 0.08);
  }
`;

// First sync at document_idle — manifest's `run_at` already covers
// "DOM ready", so the body element exists.
syncSidebar();

// YouTube emits this on every SPA navigation finish; observing it
// directly is much cheaper than polling.
document.addEventListener("yt-navigate-finish", syncSidebar);

// Browser-level fallback in case YouTube changes their event name.
// `popstate` covers back / forward navigation. We deliberately do NOT
// patch History.pushState or run a polling loop here — the
// `yt-navigate-finish` listener above already fires on every YouTube
// SPA transition (including ones triggered by pushState), so adding
// a polling fallback would be redundant noise.
window.addEventListener("popstate", syncSidebar);
