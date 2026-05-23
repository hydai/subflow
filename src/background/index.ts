// Subflow background service worker.
//
// Wires §6.8 entry point (a) (toolbar click → options page) and the
// inbound chrome.runtime.onMessage router. The router accepts the
// post-bridged player-data envelope from the main-world / isolated
// content scripts (#4), the subtitle-request flow described by
// SPEC §6.1 + §6.2 + §6.7 (#7), and the SPA-navigation /
// manual-refresh cleanups owned by the same SubtitleService.
//
// Per-tab state and the cache / dedup / fetch plumbing live in
// `./subtitle-service.ts`; this file only translates chrome messages
// into service calls.

import { PLAYER_DATA_POSTMESSAGE_TAG } from "@/lib/messages";
import { fetchSubtitleXml } from "./fetch-subtitle";
import { SubtitleService } from "./subtitle-service";
import type { PlayerDataState } from "./subtitle-service";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import type { PromptVariables, Workflow } from "@/lib/types";

const subtitles = new SubtitleService({ fetchSubtitleXml });
const orchestrator = new WorkflowOrchestrator();

// SPEC §6.6 — MV3 service workers can be terminated by Chrome when
// idle, and a workflow request that was in flight at that moment
// loses its Promise context. The "background service interrupted"
// detection works in two layers:
//
//   1. Every workflow execution is logged to chrome.storage.local
//      under \`subflow.inFlightWorkflows\` (the IN_FLIGHT_STORAGE_KEY
//      constant below) with the request envelope. When the runner
//      resolves (success OR failure), the entry is removed.
//   2. On service-worker startup, we read that key. Any residual
//      entries belonged to a previous worker that was terminated
//      mid-flight; we synthesise an outcome:"interrupted" result
//      and push it to the originating tab so the sidebar can
//      render the failure + a Retry button. Then we clear the
//      storage entry.
//
// We use chrome.storage.local rather than session storage because
// the worker termination wipes any in-memory state, and we want
// the detection to survive across worker generations (potentially
// many minutes between the original request and the next user
// action that wakes the worker).
const IN_FLIGHT_STORAGE_KEY = "subflow.inFlightWorkflows";

interface InFlightRecord {
  tabId: number;
  videoId: string;
  requestId: string;
  workflowId: string;
  workflowName: string;
  startedAt: number;
}

// Serialise the read-modify-write of subflow.inFlightWorkflows
// through a single Promise chain so concurrent dispatches can't
// interleave their updates and lose entries. Each operation
// (record OR clear) queues onto inFlightQueue; the runtime
// processes them strictly in arrival order.
let inFlightQueue: Promise<void> = Promise.resolve();

function recordInFlight(record: InFlightRecord): Promise<void> {
  return enqueueInFlightOp((current) => {
    const next = { ...current };
    next[record.requestId] = record;
    return next;
  });
}

function clearInFlight(requestId: string): Promise<void> {
  return enqueueInFlightOp((current) => {
    if (current[requestId] === undefined) return current;
    const next = { ...current };
    delete next[requestId];
    return next;
  });
}

function enqueueInFlightOp(
  fn: (current: Record<string, InFlightRecord>) => Record<string, InFlightRecord>,
): Promise<void> {
  const chained = inFlightQueue.then(async () => {
    const current = await readInFlight();
    const next = fn(current);
    if (next !== current) await writeInFlight(next);
  });
  // Keep the queue alive even if a single op rejects (e.g. quota
  // exceeded). The chained promise itself still surfaces the
  // rejection to the caller so they can choose what to do; the
  // queue-internal handle just swallows it so the next op can
  // still be scheduled.
  inFlightQueue = chained.catch(() => undefined);
  return chained;
}

async function readInFlight(): Promise<Record<string, InFlightRecord>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get([IN_FLIGHT_STORAGE_KEY], (items) => {
        // chrome.storage callbacks report failures via
        // chrome.runtime.lastError, not throws. Propagate the
        // error rather than silently returning {} — otherwise
        // enqueueInFlightOp would compute a new state from a fake
        // empty base and writeInFlight would clobber any real
        // entries that exist.
        const last = chrome.runtime.lastError;
        if (last !== undefined && last !== null) {
          reject(new Error(last.message ?? "chrome.storage.local.get failed"));
          return;
        }
        const raw = items?.[IN_FLIGHT_STORAGE_KEY];
        // No saved key at all is fine — that's an empty
        // scratchpad. Only reject types we can't iterate safely.
        if (raw === null || raw === undefined) {
          resolve({});
          return;
        }
        if (typeof raw !== "object" || Array.isArray(raw)) {
          // Saved value exists but isn't iterable as Record;
          // surface as an error rather than silently treating as
          // empty, since clobbering it could lose legitimate state
          // from a future-schema worker.
          reject(new Error("subflow.inFlightWorkflows storage shape is not a Record"));
          return;
        }
        resolve(raw as Record<string, InFlightRecord>);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function writeInFlight(
  records: Record<string, InFlightRecord>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [IN_FLIGHT_STORAGE_KEY]: records }, () => {
        // Storage failures (quota exceeded, extension reload mid-
        // write) come back via chrome.runtime.lastError. Reject so
        // the caller can decide how to surface the failure rather
        // than silently pretending the scratchpad updated.
        const last = chrome.runtime.lastError;
        if (last !== undefined && last !== null) {
          reject(new Error(last.message ?? "chrome.storage.local.set failed"));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// Run once at service-worker startup. Any in-flight entry left over
// from a previous worker generation is a request that didn't get to
// emit a result — synthesise an "interrupted" result and push it to
// the originating tab.
void replayInterruptedWorkflows().catch(() => {
  // readInFlight can reject (storage failure, unexpected stored
  // shape). Don't surface the rejection — service-worker startup
  // shouldn't crash on a corrupted scratchpad. Worst case: a
  // genuine interrupted request goes unreplayed for this wake;
  // the user can still hit Retry on the next interaction.
});

// Per-field shape check so a corrupted / hand-edited scratchpad
// can't drive replay with garbage. The replay loop only handles
// records that pass this guard; anything else is silently dropped
// (the user wouldn't have meaningful action on a malformed
// residue anyway).
function isInFlightRecord(value: unknown): value is InFlightRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  // tabId must be a non-negative integer (chrome.tabs ids are
  // positive ints) and startedAt a finite number — guard against
  // NaN / Infinity / non-int values that pass typeof but blow up
  // when handed to chrome.tabs.sendMessage / new Date().
  if (
    typeof r.tabId !== "number" ||
    !Number.isInteger(r.tabId) ||
    r.tabId < 0
  ) {
    return false;
  }
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) {
    return false;
  }
  return (
    typeof r.videoId === "string" &&
    typeof r.requestId === "string" &&
    typeof r.workflowId === "string" &&
    typeof r.workflowName === "string"
  );
}

async function replayInterruptedWorkflows(): Promise<void> {
  // Route the snapshot+clear through the serialised queue so we
  // can't race a concurrent execute-workflow dispatch. The queued
  // op atomically: (a) reads the current scratchpad, (b) captures
  // the entries to replay, (c) clears the scratchpad. Any
  // dispatches queued AFTER this op will see an empty scratchpad
  // and proceed normally; any dispatches queued BEFORE will be
  // observed here as residual entries (and we replay them — they
  // belonged to a worker generation that didn't complete).
  let entries: InFlightRecord[] = [];
  await enqueueInFlightOp((current) => {
    entries = Object.values(current).filter(isInFlightRecord);
    // Clear the scratchpad on any non-empty input — both the
    // valid records we're about to drain (so the next wake
    // doesn't replay them) AND any malformed garbage that
    // wouldn't be replayed but would otherwise persist forever.
    // Skip the write only when the scratchpad is already empty,
    // saving an unnecessary chrome.storage.local.set on every
    // clean service-worker start.
    if (Object.keys(current).length === 0) return current;
    return {};
  });
  if (entries.length === 0) return;
  // Push the interrupted-result message to each originating tab in
  // parallel. Sequencing was unnecessary — these are independent
  // tab.sendMessage calls — and the await-in-loop pattern would
  // keep the worker alive longer than the replay actually needs.
  await Promise.all(
    entries.map(async (record) => {
      try {
        await chrome.tabs.sendMessage(record.tabId, {
          type: "subflow:workflow-result",
          videoId: record.videoId,
          requestId: record.requestId,
          result: {
            workflowId: record.workflowId,
            workflowName: record.workflowName,
            // Dedicated outcome variant so the sidebar can render
            // a precise label without sniffing the body string.
            outcome: "interrupted",
            body:
              "Background service was interrupted while this workflow was running. Click Retry to start over.",
            timestamp: Date.now(),
          },
          suppressed: false,
        });
      } catch {
        // Tab may have closed in the meantime; nothing to surface.
      }
    }),
  );
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Drop the tab's entire state on close (subtitle cache, autoRun
// history, and any in-flight workflow requests) so nothing outlives
// the tab it was scoped to (§6.2, §6.5).
chrome.tabs.onRemoved.addListener((tabId) => {
  subtitles.invalidateTab(tabId);
  orchestrator.forgetTab(tabId);
});

// Narrow the inbound value just enough to read its discriminator
// safely. The runtime only verifies the `subflow:` prefix, so the
// narrowing target uses a template-literal type that matches exactly
// what was checked — not the `Message["type"]` union of known
// literals, which would be claiming more than the runtime proves.
// Per-variant validation happens at each case in the router below.
function hasSubflowType(value: unknown): value is { type: `subflow:${string}` } {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return typeof candidate.type === "string" && candidate.type.startsWith("subflow:");
}

// Validator for the "open options page" relay. The message carries
// no payload beyond the type discriminator, so the gate is just
// "the envelope has the right type field".
function isOpenOptionsPagePayload(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === "subflow:open-options-page";
}

// Sender guard: messages coming through the content-script bridge
// originate from a YouTube tab. Reject anything posted from other
// extension contexts (e.g. the options page) or from tabs on other
// origins so a compromised / hostile non-YouTube context cannot
// drive the subtitle / workflow pipelines via forged messages.
function isFromYouTubeTab(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.tab?.url;
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://www.youtube.com";
  } catch {
    return false;
  }
}

interface PlayerDataPayload {
  type: typeof PLAYER_DATA_POSTMESSAGE_TAG;
  href: string;
  result: PlayerDataState;
}

interface RequestSubtitlePayload {
  type: "subflow:request-subtitle";
  videoId: string;
  languagePriority: string[];
}

interface RefetchSubtitlePayload {
  type: "subflow:refetch-subtitle";
  videoId: string;
}

interface VideoChangedPayload {
  type: "subflow:video-changed";
  videoId: string;
}

interface ExecuteWorkflowPayload {
  type: "subflow:execute-workflow";
  workflow: Workflow;
  variables: PromptVariables;
  trigger: "manual" | "auto";
  videoId: string;
  requestId: string;
}

function isPlayerDataPayload(value: unknown): value is PlayerDataPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== PLAYER_DATA_POSTMESSAGE_TAG) return false;
  if (typeof v.href !== "string") return false;
  const result = v.result;
  if (result === null || typeof result !== "object") return false;
  const ok = (result as { ok?: unknown }).ok;
  if (typeof ok !== "boolean") return false;
  if (ok === false) {
    const error = (result as { error?: unknown }).error;
    if (error === null || typeof error !== "object") return false;
    const errType = (error as { type?: unknown }).type;
    // Restrict to the known ExtractError variants so extractErrorToStatus
    // in the service never receives an unknown literal.
    if (errType !== "MISSING_PLAYER_RESPONSE" && errType !== "MALFORMED_PLAYER_RESPONSE") {
      return false;
    }
    if (errType === "MALFORMED_PLAYER_RESPONSE") {
      return typeof (error as { reason?: unknown }).reason === "string";
    }
    return true;
  }
  // ok === true: the data side must look like ExtractedPlayerData
  // enough that the service won't crash downstream. We validate every
  // field selectTrack / parseTimedText / the §6.6 precondition checks
  // actually read.
  const data = (result as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const tracks = d.captionTracks;
  if (!Array.isArray(tracks)) return false;
  if (!tracks.every(isCaptionTrack)) return false;
  const vd = d.videoDetails;
  if (vd === null || typeof vd !== "object") return false;
  const details = vd as Record<string, unknown>;
  if (typeof details.videoId !== "string" || details.videoId.length === 0) return false;
  if (typeof details.isLive !== "boolean") return false;
  if (typeof details.isUpcoming !== "boolean") return false;
  if (details.lengthSeconds !== undefined) {
    // VideoDetails.lengthSeconds is documented as a non-negative
    // integer or undefined. Reject NaN / Infinity / negative /
    // non-integer values so parseTimedText's format choice can't be
    // skewed by a forged number.
    if (
      typeof details.lengthSeconds !== "number" ||
      !Number.isInteger(details.lengthSeconds) ||
      details.lengthSeconds < 0
    ) {
      return false;
    }
  }
  return true;
}

function isCaptionTrack(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  if (typeof t.baseUrl !== "string") return false;
  if (typeof t.languageCode !== "string") return false;
  if (typeof t.isTranslatable !== "boolean") return false;
  // `kind` is either the literal "asr" or omitted entirely.
  if (t.kind !== undefined && t.kind !== "asr") return false;
  return true;
}

function isFromSameHrefOrigin(href: string, sender: chrome.runtime.MessageSender): boolean {
  // Stale extraction results from a previously-loaded page can race
  // with a fresh sender-tab URL; require that the `href` the
  // main-world script captured at extraction time lives under the
  // same origin as the tab actually loaded today.
  if (typeof sender.tab?.url !== "string") return false;
  try {
    return new URL(href).origin === new URL(sender.tab.url).origin;
  } catch {
    return false;
  }
}

function isRequestSubtitlePayload(value: unknown): value is RequestSubtitlePayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "subflow:request-subtitle") return false;
  if (typeof v.videoId !== "string" || v.videoId.length === 0) return false;
  if (!Array.isArray(v.languagePriority)) return false;
  // Reject blank / whitespace-only entries AND entries with leading
  // or trailing whitespace. SPEC §7.4 says storage-time validation
  // trims; we double-check here so a forged or buggy message can't
  // sneak a `"en "` through (which would never match tracks via the
  // case-insensitive comparison, and would inject whitespace into
  // both cache keys and tlang URLs).
  return v.languagePriority.every(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry === entry.trim(),
  );
}

function isRefetchSubtitlePayload(value: unknown): value is RefetchSubtitlePayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "subflow:refetch-subtitle" &&
    typeof v.videoId === "string" &&
    v.videoId.length > 0
  );
}

function isVideoChangedPayload(value: unknown): value is VideoChangedPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "subflow:video-changed" &&
    typeof v.videoId === "string" &&
    v.videoId.length > 0
  );
}

function isWorkflow(value: unknown): value is Workflow {
  if (value === null || typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  if (typeof w.id !== "string" || w.id.length === 0) return false;
  if (typeof w.name !== "string" || w.name.length === 0) return false;
  // Parse via URL so whitespace, newlines, or malformed strings get
  // rejected — `startsWith("https://")` alone would accept
  // `"https:// evil.example/path\n"` and similar nonsense. We
  // require an actual `https:` scheme on a non-empty hostname.
  if (typeof w.url !== "string") return false;
  try {
    const parsed = new URL(w.url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname.length === 0) return false;
  } catch {
    return false;
  }
  // SPEC §7.4: promptTemplate is required AND non-empty. An empty
  // template would POST `{"prompt": ""}`, which is a bug, not a
  // configuration option.
  if (typeof w.promptTemplate !== "string" || w.promptTemplate.length === 0) {
    return false;
  }
  if (typeof w.autoRun !== "boolean") return false;
  // Arrays satisfy `typeof === "object"` but their numeric-string
  // keys would be spread into request headers as `"0"`, `"1"`, …,
  // which doesn't match the `Record<string, string>` contract.
  // Reject them explicitly.
  if (
    w.headers === null ||
    typeof w.headers !== "object" ||
    Array.isArray(w.headers)
  ) {
    return false;
  }
  const headers = w.headers as Record<string, unknown>;
  for (const key of Object.keys(headers)) {
    if (typeof headers[key] !== "string") return false;
    // Storage-time validation (#9 / #10) rejects user-supplied
    // Content-Type; the runner sets it. Reject defensively here too.
    if (key.toLowerCase() === "content-type") return false;
  }
  return true;
}

function isPromptVariables(value: unknown): value is PromptVariables {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.transcript !== "string") return false;
  if (typeof v.transcript_with_timestamps !== "string") return false;
  if (typeof v.video_id !== "string") return false;
  if (typeof v.video_url !== "string") return false;
  if (typeof v.language !== "string") return false;
  if (v.title !== undefined && typeof v.title !== "string") return false;
  if (v.channel !== undefined && typeof v.channel !== "string") return false;
  if (
    v.duration_seconds !== undefined &&
    (typeof v.duration_seconds !== "number" ||
      !Number.isInteger(v.duration_seconds) ||
      v.duration_seconds < 0)
  ) {
    return false;
  }
  return true;
}

function isExecuteWorkflowPayload(value: unknown): value is ExecuteWorkflowPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "subflow:execute-workflow") return false;
  if (typeof v.videoId !== "string" || v.videoId.length === 0) return false;
  if (typeof v.requestId !== "string" || v.requestId.length === 0) return false;
  if (v.trigger !== "manual" && v.trigger !== "auto") return false;
  if (!isWorkflow(v.workflow)) return false;
  if (!isPromptVariables(v.variables)) return false;
  // Cross-field consistency: the videoId on the envelope MUST match
  // the videoId carried in variables. A mismatch (sender bug or
  // forged message) would mean autoRun dedup keys against the
  // envelope's videoId while the prompt body claims a different
  // video — making cancellation, dedup, and the rendered result
  // ambiguous. Reject so the sidebar can never receive a result
  // whose prompt-vars disagree with its own envelope.
  if (v.videoId !== v.variables.video_id) return false;
  return true;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!hasSubflowType(message)) return false;
  if (!isFromYouTubeTab(sender)) return false;
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return false;

  switch (message.type) {
    case PLAYER_DATA_POSTMESSAGE_TAG:
      if (!isPlayerDataPayload(message)) return false;
      if (!isFromSameHrefOrigin(message.href, sender)) return false;
      subtitles.recordPlayerData(tabId, message.result);
      sendResponse({ ack: true });
      return false;

    case "subflow:request-subtitle":
      if (!isRequestSubtitlePayload(message)) return false;
      subtitles
        .getSubtitle(tabId, message.videoId, message.languagePriority)
        .then((result) => {
          sendResponse({ videoId: message.videoId, result });
        })
        .catch((err: unknown) => {
          // Unexpected: the service catches its own errors and
          // returns a typed SubtitleResult. If we end up here, surface
          // a fetch-failed result so the message port doesn't dangle
          // and the sender's Promise settles.
          sendResponse({
            videoId: message.videoId,
            result: {
              status: "fetch-failed",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      // Keep the message channel open so the async sendResponse fires.
      return true;

    case "subflow:refetch-subtitle":
      if (!isRefetchSubtitlePayload(message)) return false;
      subtitles.invalidateVideo(tabId, message.videoId);
      sendResponse({ ack: true });
      return false;

    case "subflow:open-options-page":
      if (!isOpenOptionsPagePayload(message)) return false;
      // Content scripts can't call chrome.runtime.openOptionsPage()
      // directly; the API is gated to "extension contexts" (i.e.
      // not page-injected scripts). Relay through the background
      // (#17 — "Open settings" CTA on missing-language-priority).
      chrome.runtime.openOptionsPage();
      sendResponse({ ack: true });
      return false;

    case "subflow:video-changed":
      if (!isVideoChangedPayload(message)) return false;
      subtitles.changeVideo(tabId, message.videoId);
      // SPEC §6.7: SPA navigation aborts all in-flight workflow
      // requests for the previous video. Their results MUST NOT
      // appear in the sidebar. The orchestrator's signal makes
      // those requests resolve with outcome: "aborted" and the
      // execute-workflow handler below suppresses that variant.
      orchestrator.abortInFlight(tabId);
      sendResponse({ ack: true });
      return false;

    case "subflow:execute-workflow":
      if (!isExecuteWorkflowPayload(message)) return false;
      {
        // The sidebar can only send a PromptVariables placeholder
        // (it has no access to the SubtitleService cache that owns
        // the real transcript / title / channel). Reconstruct the
        // real variables here from authoritative background state.
        // If the subtitle hasn't been fetched yet for this
        // (tab, video), refuse the request with a typed failure
        // result rather than POSTing an empty prompt.
        const realVariables = subtitles.buildPromptVariables(tabId, message.videoId);
        if (realVariables === null) {
          sendResponse({
            videoId: message.videoId,
            requestId: message.requestId,
            result: {
              workflowId: message.workflow.id,
              workflowName: message.workflow.name,
              // Distinct outcome so the sidebar can present this as
              // a "wait + retry" situation rather than a network
              // failure (which would suggest the endpoint is
              // unreachable).
              outcome: "precondition-failed",
              body:
                "Subtitle not loaded yet — wait for the sidebar to show \"Loaded\", then try again.",
              timestamp: Date.now(),
            },
            suppressed: false,
          });
          return false;
        }
        // Record the in-flight workflow so a service-worker
        // termination mid-fetch can be surfaced to the sidebar on
        // the next wake (see replayInterruptedWorkflows). Queue
        // the record BEFORE dispatching so a fast resolution
        // (notably an autoRun dedup hit that resolves on the next
        // microtask) can't clear before the record exists. Both
        // operations route through the serialised in-flight queue.
        const inFlightRecord: InFlightRecord = {
          tabId,
          videoId: message.videoId,
          requestId: message.requestId,
          workflowId: message.workflow.id,
          workflowName: message.workflow.name,
          startedAt: Date.now(),
        };
        // Record write SHOULD land before dispatching so a worker
        // terminated mid-fetch leaves a recoverable trail. Chain
        // dispatch off the record-landing promise via .then (the
        // router callback is sync; return true below keeps the
        // message channel open).
        //
        // Best-effort, not guaranteed: if chrome.storage.local
        // itself fails (quota exceeded, extension reload mid-
        // write), recordInFlight rejects. We catch that and
        // proceed to dispatch anyway, since refusing to run the
        // workflow because of a storage failure would be worse
        // for the user than losing the interruption-detection
        // safety net for this one request.
        const recordingPromise = recordInFlight(inFlightRecord).catch(() => {
          /* swallow — see comment above */
        });
        recordingPromise
          .then(() => {
            return message.trigger === "auto"
              ? orchestrator.runAutoRun(
                  tabId,
                  message.videoId,
                  message.workflow,
                  realVariables,
                )
              : orchestrator.runManual(tabId, message.workflow, realVariables);
          })
          .then(async (result) => {
            // autoRun dedup: a null result means "this (tabId,
            // videoId, workflowId) has already fired in this tab".
            // Still send a response so the sender's promise settles,
            // but mark it suppressed so the sidebar doesn't add an
            // entry to the result list.
            // Try to clear the in-flight record BEFORE
            // sendResponse so a worker termination immediately
            // after this microtask doesn't replay this resolved
            // request as "interrupted" on next wake.
            // Best-effort — if the clear itself errors (rare; same
            // failure modes as recordInFlight), we still need to
            // return a result to the sidebar, so swallow and
            // continue. The next replay will produce one stale
            // "interrupted" entry, which the user can dismiss via
            // Retry.
            await recordingPromise
              .then(() => clearInFlight(message.requestId))
              .catch(() => undefined);
            if (result === null) {
              // Dedup hit — no actual request was issued.
              sendResponse({
                videoId: message.videoId,
                requestId: message.requestId,
                result: null,
                suppressed: true,
              });
              return;
            }
            // SPEC §6.7: aborted requests do not produce sidebar
            // entries.
            sendResponse({
              videoId: message.videoId,
              requestId: message.requestId,
              result,
              suppressed: result.outcome === "aborted",
            });
          })
          .catch(async (err: unknown) => {
            await recordingPromise
              .then(() => clearInFlight(message.requestId))
              .catch(() => undefined);
            sendResponse({
              videoId: message.videoId,
              requestId: message.requestId,
              result: {
                workflowId: message.workflow.id,
                workflowName: message.workflow.name,
                outcome: "network-error",
                body: err instanceof Error ? err.message : String(err),
                timestamp: Date.now(),
              },
              suppressed: false,
            });
          });
      }
      // Keep the message channel open for the async sendResponse.
      return true;

    default:
      return false;
  }
});
