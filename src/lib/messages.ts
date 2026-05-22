// Discriminated union of every message that can cross the background /
// content / sidebar / options boundary. Each variant carries enough
// state for the receiver to act without a follow-up round-trip, so the
// service-worker can stay short-lived (MV3) and conversation history
// is not maintained between calls.

import type {
  ExtractResult,
  PromptVariables,
  SidebarState,
  SubtitleResult,
  Workflow,
  WorkflowResult,
} from "./types";

// Constant used as the window.postMessage bridge tag between the
// main-world and isolated content scripts. Declared above the
// message-variant types so each variant's `type` field can be linked
// to it via `typeof` rather than repeating a string literal that
// could silently drift.
export const PLAYER_DATA_POSTMESSAGE_TAG = "subflow:player-data-extracted" as const;

// Main-world content script → isolated content script → background:
// the extractor read window.ytInitialPlayerResponse and produced
// either typed data or a typed error. The isolated content script
// forwards this unchanged via chrome.runtime.sendMessage because the
// main-world script has no access to chrome.* APIs (#4).
export interface PlayerDataExtractedMessage {
  type: typeof PLAYER_DATA_POSTMESSAGE_TAG;
  // The video URL at the moment of extraction, so the receiver can
  // double-check the message belongs to the current navigation.
  href: string;
  // Mirrors the extractor's return type so any future contract change
  // (new failure variants, additional fields) propagates here without
  // a parallel edit.
  result: ExtractResult;
}

// Content → background: ask for the subtitle for the current video.
// The background owns the in-flight dedupe + cache (#7), so the
// content script does not need to remember whether it has asked
// before.
export interface RequestSubtitleMessage {
  type: "subflow:request-subtitle";
  videoId: string;
  languagePriority: string[];
}

// Background → content / sidebar: subtitle is ready (success or
// failure). For success cases the full transcript / variables travel
// with the message so the receiver can run a workflow immediately.
export interface SubtitleResultMessage {
  type: "subflow:subtitle-result";
  videoId: string;
  result: SubtitleResult;
}

// Sidebar → background: user clicked a manual workflow button, or an
// autoRun workflow fired for this video. The background performs the
// fetch (#15) so request lifecycle is owned by the service worker.
export interface ExecuteWorkflowMessage {
  type: "subflow:execute-workflow";
  workflow: Workflow;
  variables: PromptVariables;
  // `"manual"` → no dedup, always runs (SPEC §6.5).
  // `"auto"`   → background dedups by (tabId, videoId, workflowId)
  //              per SPEC §6.5; if the triple has already fired in
  //              this tab, the response carries `result: null` and
  //              `suppressed: true`, and no workflow request is
  //              issued. The caller still gets a settled promise so
  //              its dispatch state machine can move on.
  trigger: "manual" | "auto";
  // Used to associate the response with the right sidebar entry and
  // to support SPA-switch cancellation (#16).
  videoId: string;
  requestId: string;
}

// Background → sidebar: workflow finished (success / http error /
// network error / timeout / aborted).
export interface WorkflowResultMessage {
  type: "subflow:workflow-result";
  videoId: string;
  requestId: string;
  result: WorkflowResult;
}

// Sidebar → background / content: user pressed "重新抓取字幕". Clears
// the in-memory cache for (videoId, language) and re-reads.
export interface RefetchSubtitleMessage {
  type: "subflow:refetch-subtitle";
  videoId: string;
}

// Content → background / sidebar: YouTube SPA switched videos. The
// background drops cached subtitles, aborts in-flight workflow
// requests for the previous video (#16), and the sidebar resets its
// per-video state.
export interface VideoChangedMessage {
  type: "subflow:video-changed";
  videoId: string;
}

// Content → sidebar (in-page): broadcast the latest sidebar state so
// the injected UI can re-render. The sidebar UI is stateful only for
// the duration of the tab, so this is the single source of truth.
export interface SidebarStateMessage {
  type: "subflow:sidebar-state";
  state: SidebarState;
}

export type Message =
  | PlayerDataExtractedMessage
  | RequestSubtitleMessage
  | SubtitleResultMessage
  | ExecuteWorkflowMessage
  | WorkflowResultMessage
  | RefetchSubtitleMessage
  | VideoChangedMessage
  | SidebarStateMessage;
