// Shared type definitions for the Subflow extension.
//
// These are the contracts every downstream issue (M2-M5) refers back
// to. Each comment block names the SPEC section that owns the field
// semantics. Validation rules live with the code that performs them
// (see #10 for language priority, #15 for workflow execution, etc.) —
// the types here are deliberately structural so the same shape can be
// emitted by storage, consumed by the sidebar, and serialised across
// the background/content/options/sidebar boundaries.

// --------------------------------------------------------------------
// SPEC §7.4 — `chrome.storage.local` structure
// --------------------------------------------------------------------

export interface Preferences {
  // Ordered list of BCP-47 codes; the head wins. Casing is preserved as
  // entered by the user. BCP-47 syntax is not enforced at the type
  // level (see #10 for the storage-time validator).
  languagePriority: string[];
}

export interface Workflow {
  id: string;
  name: string;
  url: string;
  promptTemplate: string;
  autoRun: boolean;
  // Defaults to `{}` when omitted by the user. `Content-Type` must not
  // appear here (case-insensitive) — the workflow request always sets
  // it to `application/json`. The check happens at storage time (#9 /
  // #10) and again at request time (#15).
  headers: Record<string, string>;
}

// --------------------------------------------------------------------
// SPEC §6.1.1 — Extracted YouTube player data
// --------------------------------------------------------------------

export interface VideoDetails {
  videoId: string;
  // Optional metadata fields — when missing or wrong-typed the
  // extractor returns `undefined` rather than throwing, so the
  // prompt-replacement step (§7.3) can fall back to "leave the
  // placeholder verbatim".
  title?: string;
  author?: string;
  // YouTube delivers `lengthSeconds` as a numeric string; the extractor
  // converts it to a non-negative integer or leaves it undefined when
  // the value is missing or cannot be parsed.
  lengthSeconds?: number;
  isLive: boolean;
  isUpcoming: boolean;
}

export interface ExtractedPlayerData {
  videoDetails: VideoDetails;
  // Empty array means YouTube exposed no caption tracks for this
  // video. That is not an extraction failure — it's a §6.6 "no
  // subtitles available" situation handled by #17.
  captionTracks: CaptionTrack[];
}

export type ExtractError =
  | { type: "MISSING_PLAYER_RESPONSE" }
  | { type: "MALFORMED_PLAYER_RESPONSE"; reason: string };

export type ExtractResult =
  | { ok: true; data: ExtractedPlayerData }
  | { ok: false; error: ExtractError };

// --------------------------------------------------------------------
// SPEC §7.1 — YouTube caption tracks
// --------------------------------------------------------------------

export type CaptionSource = "human" | "auto" | "translation";

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  // YouTube uses `kind: "asr"` for auto-generated tracks and omits
  // `kind` for human tracks. The presence/absence of this field is the
  // signal used by the caption-track selector in #5.
  kind?: "asr";
  isTranslatable: boolean;
}

export interface SelectedTrack {
  source: CaptionSource;
  // The "actually matched language code" defined in SPEC §6.1: for
  // direct matches it is the track's `languageCode` as YouTube returned
  // it (original casing preserved); for translation-derived matches it
  // is the user's preferred language code that was appended as
  // `tlang=`.
  languageCode: string;
  baseUrl: string;
}

// --------------------------------------------------------------------
// SPEC §6.1 / §6.6 — Subtitle results
// --------------------------------------------------------------------

export type SubtitleStatus =
  | "ok"
  | "no-subtitle"
  | "fetch-failed"
  | "parse-failed"
  | "live-or-premiere"
  | "missing-language-priority";

export interface SubtitleSuccess {
  status: "ok";
  // Plain-text transcript, lines separated by `\n`, no timestamps.
  transcript: string;
  // `[mm:ss]` or `[hh:mm:ss]` per line, format chosen once per video.
  transcriptWithTimestamps: string;
  // The matched language code (see SelectedTrack.languageCode).
  language: string;
  source: CaptionSource;
}

export interface SubtitleFailure {
  status: Exclude<SubtitleStatus, "ok">;
  // Optional human-readable diagnostic for the sidebar; not always set.
  message?: string;
}

export type SubtitleResult = SubtitleSuccess | SubtitleFailure;

// --------------------------------------------------------------------
// SPEC §7.3 — Prompt template variables
// --------------------------------------------------------------------

export interface PromptVariables {
  transcript: string;
  transcript_with_timestamps: string;
  // `title`, `channel`, and `duration_seconds` derive from
  // `videoDetails.{title, author, lengthSeconds}`, all of which the
  // extractor allows to be undefined per SPEC §7.3
  // ("videoDetails 中對應欄位缺失時，該變數視為未定義").
  title: string | undefined;
  video_id: string;
  video_url: string;
  channel: string | undefined;
  // Matched language code (mirrors SelectedTrack.languageCode).
  language: string;
  // Integer seconds; the variable replacement step (#14) stringifies.
  duration_seconds: number | undefined;
}

// --------------------------------------------------------------------
// SPEC §6.4 — Sidebar state and workflow results
// --------------------------------------------------------------------

export type WorkflowOutcome = "success" | "http-error" | "network-error" | "timeout" | "aborted";

export interface WorkflowResult {
  workflowId: string;
  workflowName: string;
  outcome: WorkflowOutcome;
  // HTTP status when known (success or http-error); omitted otherwise.
  statusCode?: number;
  // The response body (or error message) the sidebar will display.
  // 4xx/5xx bodies are truncated to 2000 chars per SPEC §7.6; 2xx
  // bodies are shown in full. Truncation is the responsibility of #15.
  body: string;
  // Unix milliseconds.
  timestamp: number;
}

export interface SidebarState {
  // null when the sidebar has not yet read subtitles for this video.
  subtitleStatus: SubtitleStatus | null;
  collapsed: boolean;
  // Most recent first; capped at 5 entries (SPEC §6.4).
  results: WorkflowResult[];
}
