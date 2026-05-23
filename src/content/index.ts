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
// "module"`), so the emitted bundle must contain no ESM module
// syntax. We deliberately keep the @/lib imports limited to modules
// that THIS file is the only consumer of (parseWatchPageUrl from
// @/lib/watch-page and addResult / truncateBody from
// @/lib/sidebar-utils). Rollup inlines those into the classic-script
// bundle. Message tag constants are duplicated inline rather than
// imported from @/lib/messages — that module is shared with
// background, and a shared import would force Rollup to emit a
// chunk that breaks the classic-script load. The drift test in
// tests/content-bridge.test.ts keeps the inline duplicates in sync.

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
    // video-changed. Drop sidebarState too so the workflows array,
    // result list, and cached subtitle stop occupying memory for
    // the (possibly long-lived) period the user is browsing
    // non-watch pages. Bump renderEpoch so any in-flight
    // renderSidebar awaits return early — their captured shadow
    // ref is now detached and painting into it would leak memory
    // and (worse) cause request-subtitle to fire for a no-longer-
    // displayed video.
    if (sidebarRoot !== null) {
      sidebarRoot.remove();
      sidebarRoot = null;
      sidebarShadow = null;
    }
    sidebarState = null;
    // SPEC §6.8: workflow / preference changes take effect on the
    // NEXT watch-page LOAD. Leaving and re-entering /watch counts
    // as a new load, so drop the cache so the next mount re-reads
    // from storage.
    cachedWorkflows = null;
    workflowsLoadFailed = false;
    // Drop the scroll-restore cookie too — the next mount gets a
    // fresh sidebar and there's no meaningful position to restore.
    savedScrollBeforeCollapse = null;
    renderEpoch += 1;
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
// and re-paint the shadow root from this state on each update. The
// current implementation does a full shadow.replaceChildren() rebuild
// on every paint — incremental DOM reconciliation (preserving scroll
// / focus inside the sidebar) is a known follow-up and intentionally
// out of scope for the initial #12 cut.
//
// Named SidebarUiState here to avoid colliding with the
// `SidebarState` exported from src/lib/types.ts, which is the
// messaging-shape used to broadcast sidebar state across the
// background / content boundary. That shape is a subset of this
// one (subtitle status + collapsed + results), without workflows
// or the videoId scope that the renderer needs.
interface SidebarUiState {
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
  // videoId scope for the current sidebar instance. Reset on every
  // SPA navigation.
  videoId: string;
}

let sidebarState: SidebarUiState | null = null;
// Cached across SPA navigations within the same tab. SPEC §6.8: a
// settings change in the options page only takes effect on the NEXT
// watch page load — not on every videoId switch. Loading
// chrome.storage.local each SPA navigation would (a) bombard the
// storage API and (b) make the SPEC promise harder to reason about
// (the user might see workflows shift mid-session). Cleared on tab
// close along with the rest of the module state.
let cachedWorkflows: Workflow[] | null = null;
// Set to true when chrome.storage.local couldn't be read, so the UI
// can show a distinct "cannot read workflow settings" state instead
// of pretending the user has no workflows configured (SPEC §6.6).
let workflowsLoadFailed = false;
// Sidebar collapsed flag (#13). SPEC §6.4: the collapse state is
// preserved across SPA navigations within the same tab but reset
// on a full page reload, so we keep it as a module-scoped boolean
// (which reloads with the page) rather than chrome.storage.local.
// Default false → sidebar starts expanded.
let sidebarCollapsed = false;
// Captured scrollTop of the expanded root, set when the user
// collapses. The next expand restores from this value so toggling
// doesn't reset the user's scroll position (CSS overflow: hidden
// + display: none on the inner sections would otherwise clamp
// scrollTop to 0 while collapsed).
let savedScrollBeforeCollapse: number | null = null;
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
  // A fresh mount means the previous root element is being thrown
  // away (paintSidebar's shadow.replaceChildren()). Any scroll
  // position the user had stashed via the collapse toggle was
  // captured on the OLD root; restoring it onto the NEW root would
  // mean "scrolled to byte N of the previous video's result list"
  // — nonsensical. Reset so the next expand on this fresh sidebar
  // starts at the top.
  savedScrollBeforeCollapse = null;
  // Install a minimal sync sidebarState immediately so the
  // chrome.runtime.onMessage listener can sanity-check incoming
  // pushes (which arrive without waiting for loadWorkflows) — and
  // crucially so any subtitle / workflow result push that arrives
  // DURING the workflows-load await is captured rather than lost.
  sidebarState = {
    workflows: [],
    subtitle: null,
    results: [],
    videoId,
  };
  paintSidebar(shadow, sidebarState);
  const workflows = await loadWorkflows();
  if (renderEpoch !== myEpoch) {
    // A newer SPA navigation already started rendering; bail so we
    // don't overwrite the newer videoId's state.
    return;
  }
  // Preserve any subtitle / results that landed during the await.
  // Only overwrite workflows.
  if (sidebarState !== null && sidebarState.videoId === videoId) {
    sidebarState.workflows = workflows;
  } else {
    sidebarState = {
      workflows,
      subtitle: null,
      results: [],
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
        // Trim and drop blanks so the background validator
        // (isRequestSubtitlePayload, which rejects whitespace /
        // empty entries) doesn't silently refuse the message when
        // storage held minor garbage like a trailing newline.
        languagePriority = (langs as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
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
  // Cached across SPA navigations per SPEC §6.8 — workflows are
  // read ONCE per watch-page session and not subscribed to. A user
  // editing in the options page sees their changes on the next
  // /watch URL load. Read errors are also remembered (in
  // workflowsLoadFailed) so the sidebar can distinguish "couldn't
  // read settings" from "no manual workflows configured".
  if (cachedWorkflows !== null) return cachedWorkflows;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["workflows"], (items) => {
        const last = chrome.runtime.lastError;
        if (last !== undefined && last !== null) {
          workflowsLoadFailed = true;
          resolve([]);
          return;
        }
        const raw = items?.workflows;
        if (!Array.isArray(raw)) {
          // No `workflows` key at all is fine — empty list. We only
          // raise the failure flag when the storage API itself
          // failed (above).
          cachedWorkflows = [];
          // Successful read; clear any stale failure flag.
          workflowsLoadFailed = false;
          resolve(cachedWorkflows);
          return;
        }
        // Sanitize each entry — storage could contain malformed data
        // (manual edit, older schema, or partial write). Drop
        // anything that doesn't have the shape we render against, so
        // renderWorkflowButtons can't crash on \`w.autoRun\` of a
        // non-object.
        const sanitized = (raw as unknown[]).filter(isWorkflowShape);
        cachedWorkflows = sanitized;
        workflowsLoadFailed = false;
        resolve(sanitized);
      });
    } catch {
      workflowsLoadFailed = true;
      resolve([]);
    }
  });
}

// Matches the background's isWorkflow validator so the sidebar
// can't render a button for a workflow that the background would
// reject. Symmetric across the wire: same fields, same URL
// constraints (WHATWG URL parse + https: scheme + non-empty
// hostname), same Content-Type rejection.
function isWorkflowShape(value: unknown): value is Workflow {
  if (value === null || typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  if (typeof w.id !== "string" || w.id.length === 0) return false;
  if (typeof w.name !== "string" || w.name.length === 0) return false;
  if (typeof w.url !== "string") return false;
  try {
    const parsed = new URL(w.url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname.length === 0) return false;
  } catch {
    return false;
  }
  if (typeof w.promptTemplate !== "string" || w.promptTemplate.length === 0) {
    return false;
  }
  if (typeof w.autoRun !== "boolean") return false;
  if (
    w.headers === null ||
    typeof w.headers !== "object" ||
    Array.isArray(w.headers)
  ) {
    return false;
  }
  const headers = w.headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") return false;
    if (key.toLowerCase() === "content-type") return false;
  }
  return true;
}

function paintSidebar(shadow: ShadowRoot, state: SidebarUiState): void {
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = SIDEBAR_CSS;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "subflow-root";
  if (sidebarCollapsed) root.classList.add("collapsed");

  const header = document.createElement("header");
  header.className = "subflow-header";
  // Title is always present in the DOM; in collapsed mode the CSS
  // hides it via .subflow-root.collapsed .subflow-title so the panel
  // narrows to just the toggle button. (Keeping the node lets us
  // re-expand without a re-render burst.)
  const title = document.createElement("span");
  title.className = "subflow-title";
  title.textContent = "Subflow";
  header.appendChild(title);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "subflow-collapse-toggle";
  toggle.setAttribute(
    "aria-label",
    sidebarCollapsed ? "Expand Subflow sidebar" : "Collapse Subflow sidebar",
  );
  toggle.setAttribute("aria-expanded", sidebarCollapsed ? "false" : "true");
  // Visible glyph: a chevron pointing toward the expand direction
  // (left when collapsed → "expand to the left"; right when
  // expanded → "collapse to the right"). The aria-label carries
  // the actual semantics for screen readers.
  toggle.textContent = sidebarCollapsed ? "‹" : "›";
  toggle.addEventListener("click", () => {
    // Toggle WITHOUT re-painting from scratch — the sections under
    // .subflow-root are static at this point (DOM order doesn't
    // change with collapsed state, only CSS visibility), so the
    // cheaper move is to flip the class on the root and update the
    // toggle's own attributes. This preserves keyboard focus on the
    // toggle (which the user just clicked).
    //
    // Capture the scroll position BEFORE collapsing so re-expanding
    // lands the user back where they were. Without this, collapsing
    // sets `overflow: hidden` + `display: none` on the sections,
    // which causes the browser to clamp scrollTop to 0 — the
    // captured value lets us restore it after re-expanding.
    const wasCollapsed = sidebarCollapsed;
    const savedScrollTop = wasCollapsed ? null : root.scrollTop;
    sidebarCollapsed = !sidebarCollapsed;
    root.classList.toggle("collapsed", sidebarCollapsed);
    toggle.setAttribute(
      "aria-label",
      sidebarCollapsed ? "Expand Subflow sidebar" : "Collapse Subflow sidebar",
    );
    toggle.setAttribute("aria-expanded", sidebarCollapsed ? "false" : "true");
    toggle.textContent = sidebarCollapsed ? "‹" : "›";
    if (!sidebarCollapsed) {
      // Re-expanding: restore the saved scrollTop on the NEXT frame
      // so layout finishes settling. The capture above stored the
      // pre-collapse value the previous time the user collapsed;
      // we recover it via a module-scoped variable so consecutive
      // toggle clicks (collapse → expand → collapse → expand) all
      // round-trip.
      const target = savedScrollBeforeCollapse;
      if (target !== null) {
        requestAnimationFrame(() => {
          root.scrollTop = target;
        });
      }
    } else if (savedScrollTop !== null) {
      // Collapsing: stash the position so the next expand can
      // restore. Cleared on full repaints (paintSidebar) since the
      // root element is replaced — that's intentional, the user
      // gets a fresh top-of-list view on the next mount.
      savedScrollBeforeCollapse = savedScrollTop;
    }
  });
  header.appendChild(toggle);
  root.appendChild(header);

  // The rest of the sections are hidden via CSS when .collapsed is
  // set on the root, but we still build the DOM so re-expanding is
  // instantaneous (no re-fetch / re-compute).
  root.appendChild(renderSubtitleStatus(state));
  root.appendChild(renderWorkflowButtons(state, shadow));
  root.appendChild(renderResultList(state));
  root.appendChild(renderRefreshButton(state));

  shadow.appendChild(root);
}

function renderSubtitleStatus(state: SidebarUiState): HTMLElement {
  const section = document.createElement("section");
  section.className = "subflow-status";
  const heading = document.createElement("h3");
  heading.textContent = "Subtitle";
  section.appendChild(heading);
  const status = document.createElement("p");
  status.className = "subflow-status-text";
  if (state.subtitle === null) {
    status.textContent = "Loading…";
    section.appendChild(status);
    return section;
  }
  if (state.subtitle.status === "ok") {
    status.textContent = `Loaded (${state.subtitle.language})`;
    section.appendChild(status);
    return section;
  }
  // SPEC §6.6 — each failure status maps to a specific message and
  // (where actionable) a CTA. The CTA buttons share the inline
  // subflow-cta-button class so the user can distinguish them from
  // the workflow button row.
  status.classList.add("error");
  const cta = renderSubtitleCta(state.subtitle, state.videoId);
  status.textContent = subtitleErrorMessage(state.subtitle);
  section.appendChild(status);
  if (cta !== null) section.appendChild(cta);
  return section;
}

function subtitleErrorMessage(result: SubtitleResult): string {
  if (result.status === "ok") return "";
  switch (result.status) {
    case "missing-language-priority":
      return "Set a language preference in the Subflow options page before this video can be read.";
    case "no-subtitle":
      return "No subtitles available for this video.";
    case "fetch-failed":
      return "Could not download the subtitle from YouTube.";
    case "parse-failed":
      return "Could not parse this YouTube page. Try reloading the tab.";
    case "live-or-premiere":
      return "Subflow doesn't support live streams or premieres.";
  }
  // Defensive fallback for an unknown status; the type is closed, so
  // this only fires if a future status is added without updating
  // the switch above.
  return "Subtitle unavailable.";
}

function renderSubtitleCta(
  result: SubtitleResult,
  videoId: string,
): HTMLElement | null {
  if (result.status === "ok") return null;
  switch (result.status) {
    case "missing-language-priority":
      return ctaButton("Open settings", () => {
        // chrome.runtime.openOptionsPage() can only be called from
        // a privileged extension context (background / options /
        // popup), NOT from a content script injected into a page.
        // Relay the request through the background, which is the
        // canonical place that pattern is documented in Chrome's
        // extension docs. See also tests/content-bridge.test.ts —
        // every subflow:* tag this file emits needs both an
        // allowlist entry and an explanation at the call site.
        void chrome.runtime.sendMessage({ type: "subflow:open-options-page" });
      });
    case "fetch-failed":
      return ctaButton("Retry", () => {
        void refreshSubtitle(videoId);
      });
    case "parse-failed":
      return ctaButton("Reload page", () => {
        window.location.reload();
      });
    case "no-subtitle":
    case "live-or-premiere":
      // No remedial action — the video simply doesn't have data the
      // user can produce by clicking a button.
      return null;
  }
  return null;
}

function ctaButton(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "subflow-cta-button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderWorkflowButtons(
  state: SidebarUiState,
  shadow: ShadowRoot,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "subflow-workflows";
  const heading = document.createElement("h3");
  heading.textContent = "Workflows";
  section.appendChild(heading);

  if (workflowsLoadFailed) {
    const err = document.createElement("p");
    err.className = "subflow-empty";
    err.textContent =
      "Could not read workflow settings. Open the Subflow options page to verify and retry.";
    section.appendChild(err);
    return section;
  }

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

  // SPEC §6.6: subtitle precondition states disable workflow
  // buttons. Disable when:
  //   - subtitle not yet loaded (null → "Loading…")
  //   - subtitle resolved to any failure status (no transcript to
  //     send, so a workflow request would be precondition-failed)
  const subtitleReady =
    state.subtitle !== null && state.subtitle.status === "ok";

  const row = document.createElement("div");
  row.className = "subflow-button-row";
  for (const workflow of manualWorkflows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "subflow-workflow-button";
    button.textContent = workflow.name;
    button.disabled = !subtitleReady;
    if (!subtitleReady) {
      button.title = "Waiting for subtitle to load.";
    }
    button.addEventListener("click", () => {
      void triggerWorkflow(workflow, shadow);
    });
    row.appendChild(button);
  }
  section.appendChild(row);
  return section;
}

function renderResultList(state: SidebarUiState): HTMLElement {
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

  // SPEC §6.6 #18: Retry button appears for outcomes the user can
  // reasonably want to retry — 5xx, timeout, network-error,
  // precondition-failed, and the synthetic "background interrupted"
  // result (also a network-error). NOT 4xx (user-config error)
  // and NOT aborted (suppressed by the response handler anyway).
  if (shouldOfferRetry(result)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "subflow-cta-button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void retryWorkflow(result.workflowId);
    });
    item.appendChild(retry);
  }

  return item;
}

function shouldOfferRetry(result: WorkflowResult): boolean {
  if (result.outcome === "success") return false;
  if (result.outcome === "aborted") return false;
  if (result.outcome === "http-error") {
    // SPEC §6.6: Retry is for failures the user can plausibly
    // recover from by re-running. 4xx is typically a user-config
    // bug (wrong URL, wrong auth) — retrying without editing
    // produces the same 4xx. 3xx is a redirect notice that fetch
    // chose to surface as http-error (Response.ok === false for
    // 3xx too); since fetch follows redirects by default, a
    // surfaced 3xx means the endpoint is misconfigured in a way
    // retries won't fix. ONLY 5xx server errors get the button.
    if (
      result.statusCode === undefined ||
      result.statusCode < 500 ||
      result.statusCode > 599
    ) {
      return false;
    }
    return true;
  }
  return true;
}

async function retryWorkflow(workflowId: string): Promise<void> {
  if (sidebarState === null || sidebarShadow === null) return;
  // Look up the latest definition of this workflow from the
  // cached list, in case the user edited it between the failure
  // and the retry. (cachedWorkflows reflects the workflows as of
  // the current watch-page mount, per SPEC §6.8.)
  const workflow = sidebarState.workflows.find((w) => w.id === workflowId);
  if (workflow === undefined) {
    // Workflow was deleted between the failure and the retry —
    // there's nothing to retry. Silently no-op; the result entry
    // stays in the list so the user can see they attempted it.
    return;
  }
  await triggerWorkflow(workflow, sidebarShadow);
}

function formatOutcomeLabel(result: WorkflowResult): string {
  switch (result.outcome) {
    case "success":
      return `Success (HTTP ${result.statusCode})`;
    case "http-error":
      if (result.statusCode === undefined) return "HTTP error";
      if (result.statusCode >= 500 && result.statusCode <= 599) {
        return `Server error (HTTP ${result.statusCode})`;
      }
      if (result.statusCode >= 400 && result.statusCode <= 499) {
        return `Client error (HTTP ${result.statusCode})`;
      }
      // 3xx (Response.ok is also false for these) — surface the
      // status code without falsely calling it a client error.
      return `HTTP ${result.statusCode}`;
    case "timeout":
      // Don't hard-code the timeout duration here; the runner's
      // result body already carries the canonical phrasing
      // ("Request timed out after Ns") so the UI stays in sync with
      // WORKFLOW_TIMEOUT_MS even if it changes.
      return "Timed out";
    case "aborted":
      return "Aborted";
    case "network-error":
      return "Workflow request failed";
    case "precondition-failed":
      return "Waiting for subtitle";
  }
}

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderRefreshButton(state: SidebarUiState): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "subflow-refresh";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "subflow-refresh-button";
  button.textContent = "Refresh subtitle";
  button.addEventListener("click", () => {
    void refreshSubtitle(state.videoId);
  });
  wrap.appendChild(button);
  return wrap;
}

async function refreshSubtitle(videoId: string): Promise<void> {
  // Two-step: ask the background to invalidate its cache for this
  // video, then trigger a fresh request-subtitle so the sidebar's
  // subtitle status repaints. Without the second step, refetch-
  // subtitle just clears the cache and leaves the UI stuck on the
  // old "Loaded …" status until the next user action.
  if (sidebarShadow === null) return;
  // Optimistically reset the status to "Loading…" so the user gets
  // immediate feedback that the click was received.
  if (sidebarState !== null && sidebarState.videoId === videoId) {
    sidebarState.subtitle = null;
    paintSidebar(sidebarShadow, sidebarState);
  }
  try {
    await chrome.runtime.sendMessage({
      type: "subflow:refetch-subtitle",
      videoId,
    });
  } catch {
    // Background unreachable; the requestSubtitle below will surface
    // the failure in its own way.
  }
  void requestSubtitle(videoId, sidebarShadow, renderEpoch);
}

async function triggerWorkflow(
  workflow: Workflow,
  shadow: ShadowRoot,
): Promise<void> {
  if (sidebarState === null) return;
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

const VALID_WORKFLOW_OUTCOMES = new Set([
  "success",
  "http-error",
  "network-error",
  "timeout",
  "aborted",
  "precondition-failed",
]);

function isWorkflowResponse(value: unknown): value is WorkflowResponse {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.videoId !== "string") return false;
  if (typeof v.requestId !== "string") return false;
  if (v.result === null) return true;
  if (v.result === undefined || typeof v.result !== "object") return false;
  const r = v.result as Record<string, unknown>;
  if (typeof r.workflowId !== "string") return false;
  if (typeof r.workflowName !== "string") return false;
  if (typeof r.outcome !== "string") return false;
  // Reject unknown outcomes so formatOutcomeLabel's switch can't
  // fall through and render `undefined`. If a future variant lands
  // we'll need to update both this set AND the formatter together.
  if (!VALID_WORKFLOW_OUTCOMES.has(r.outcome)) return false;
  if (typeof r.body !== "string") return false;
  if (typeof r.timestamp !== "number") return false;
  // statusCode is only meaningful for success / http-error and must
  // be a number if present. Reject if it's present but malformed.
  if (
    r.statusCode !== undefined &&
    (typeof r.statusCode !== "number" || !Number.isFinite(r.statusCode))
  ) {
    return false;
  }
  // For success / http-error, statusCode MUST be present so
  // formatOutcomeLabel can render "HTTP 200" / "HTTP 503" without
  // showing "HTTP undefined".
  if (
    (r.outcome === "success" || r.outcome === "http-error") &&
    typeof r.statusCode !== "number"
  ) {
    return false;
  }
  return true;
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
    transition: width 0.2s ease;
  }
  .subflow-root.collapsed {
    width: 40px;
    padding: 0.25rem;
    overflow: hidden;
  }
  .subflow-root.collapsed > section,
  .subflow-root.collapsed .subflow-title {
    display: none;
  }
  .subflow-root.collapsed .subflow-header {
    margin-bottom: 0;
    justify-content: center;
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 700;
    font-size: 1em;
    margin-bottom: 0.75rem;
    color: #2563eb;
  }
  .subflow-collapse-toggle {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    width: 1.6rem;
    height: 1.6rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .subflow-collapse-toggle:hover {
    background: rgba(127, 127, 127, 0.08);
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
  .subflow-cta-button {
    margin-top: 0.4rem;
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
  }
  .subflow-cta-button:hover {
    background: rgba(127, 127, 127, 0.08);
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
