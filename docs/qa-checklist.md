# Subflow manual QA checklist

A single-pass acceptance checklist for shipping a Subflow release to the Chrome Web Store. Every item below corresponds to a SPEC section; the goal is to exercise every user journey from §5.2 and every error scenario from §6.6 on a real Chrome (and a real Microsoft Edge) build.

> Use a clean Chrome profile so that pre-existing `chrome.storage.local` state from prior runs does not affect outcomes. Reset between sections by either uninstalling/reinstalling the unpacked extension or by clearing storage from `chrome://extensions/` → Subflow → "Inspect views: service worker" → console → `chrome.storage.local.clear()`.

## Build & install (gate)

- [ ] `npm run typecheck` exits 0.
- [ ] `npm run test` reports all tests passing.
- [ ] `npm run package` exits 0 and writes `subflow-v<version>.zip`.
- [ ] Unpacking the zip shows `manifest.json`, `background.js`, `content.js`, `content-main.js`, `options.html`, `options.js`, `sidebar.js`, `icons/`, and no `node_modules/` or `*.map` files.
- [ ] `subflow-v<version>.zip` is under the Chrome Web Store 10 MB upload limit.
- [ ] Dragging the zip into `chrome://extensions/` (or "Load unpacked" on the extracted dist/) succeeds with no console errors.
- [ ] Manifest permission dialog lists only "Read your data on www.youtube.com" — nothing else.

## User journeys (SPEC §5.2)

### A. First-time setup

- [ ] Toolbar Subflow icon is visible. Hovering it shows the tooltip "Subflow".
- [ ] Clicking the toolbar icon opens the Subflow options page (no popup).
- [ ] Adding `zh-TW` and `en` to the language priority and clicking Save persists to `chrome.storage.local` (verify via DevTools → Application → Storage → Local Storage / Extension storage).
- [ ] Creating a new workflow with a valid HTTPS URL, prompt template, and `autoRun: false` adds it to the list.
- [ ] Visiting any YouTube watch page now shows a sidebar listing this workflow.

### B. Manual workflow execution

- [ ] On a watch page with captions, the workflow button is enabled.
- [ ] Clicking the button shows an "executing" state in the result list.
- [ ] The endpoint receives one POST with `Content-Type: application/json`, body `{"prompt": "<your substituted template>"}`, and any custom headers configured.
- [ ] The response body appears as a new (most-recent) entry in the result list.
- [ ] Repeated clicks send repeated requests (no client-side dedup), each becoming its own result entry.
- [ ] The list never holds more than five entries; the oldest is evicted on overflow.

### C. Auto-run workflow

- [ ] Marking an existing workflow `autoRun: true` and reloading a watch page triggers exactly one request automatically per `(videoId, workflowId)` per tab session.
- [ ] Refreshing the same video in the same tab does NOT re-trigger (the dedup keys persist for the tab's lifetime).
- [ ] Switching to a different YouTube video via SPA navigation triggers auto-run once for that new video.
- [ ] Multiple `autoRun: true` workflows on the same video fire in parallel (results all appear; ordering follows fetch completion).

### D. Manual subtitle re-fetch

- [ ] After loading a video, the sidebar shows a subtitle-status indicator ("cached" / "just-read").
- [ ] Clicking "Refresh subtitle" clears the in-memory subtitle for this video in this tab and re-fetches from YouTube; status updates to "just-read".
- [ ] Any workflow request currently in flight is NOT aborted by the refresh; it completes using the old subtitle.
- [ ] After a successful refresh, the next workflow trigger uses the new subtitle.

## Error scenarios (SPEC §6.6)

For each row, set up the trigger, then verify the sidebar message matches the expected copy AND that no toast / `chrome.notifications` / `alert()` / console error is used to surface the failure (SPEC §7.6).

| Scenario | Trigger | Expected sidebar state |
| --- | --- | --- |
| Empty `languagePriority` | Save an empty priority on the options page, reload a watch page | Sidebar shows "Set language preference on the options page"; workflow buttons disabled |
| Video has no captions | Open a watch page for a video with `captions.captionTracks` empty | Sidebar shows "No subtitle for this video"; workflow buttons disabled |
| YouTube subtitle fetch fails | Force the timed-text fetch to return 5xx (e.g. via DevTools Network → Block request) | Sidebar shows "Subtitle fetch failed" with a "Retry" button; workflow buttons disabled |
| `ytInitialPlayerResponse` missing | Run on a YouTube page where the global is stripped (e.g. SPA edge case) | Sidebar shows "Could not parse YouTube page data" with a "Reload page" hint; workflow buttons disabled |
| AI endpoint 4xx | Configure a workflow URL that returns 4xx | Sidebar shows HTTP status code and the response body truncated to 2000 chars with `…(truncated)` |
| AI endpoint 5xx | Configure a workflow URL that returns 5xx | Same as 4xx, plus a "Retry" button |
| AI endpoint timeout | Configure a workflow URL that delays response > 60 s | Sidebar shows "Workflow timed out" plus a "Retry" button after 60 s |
| AI endpoint network failure | Configure a workflow URL on a non-CORS-allowing or unreachable host | Sidebar shows "Workflow request failed" with the underlying error message and a "Retry" button |
| Service worker terminated mid-flight | Trigger a workflow then immediately reload `chrome://extensions/` Subflow card | Result list shows "Background service interrupted" with a "Retry" button |
| Workflow form rejects `Content-Type` header | Try to save a workflow with `headers: { "Content-Type": "text/plain" }` (any casing) | Save blocked; inline error references the header |
| Workflow form rejects `http://` URL | Try to save a workflow with `http://example.com` | Save blocked; inline error |
| `chrome.storage.local.set` fails | Fill `chrome.storage.local` near its 5 MB quota and try to save | Save blocked; inline error includes the underlying chrome.runtime.lastError message |
| `chrome.storage.local.get` fails | (Hard to simulate) Force `get` to reject via debugger | Sidebar shows "Could not read workflow settings" with a "Retry" button; subtitle reading is unaffected |
| Live video | Open a live stream URL | Sidebar shows "Subflow does not support live / premiere"; workflow buttons disabled |
| Premiere (upcoming) | Open a premiere countdown URL | Same as live |
| Undefined prompt variable | Use a template with `{{nonexistent}}` and run | The substituted prompt sent to the endpoint contains the literal `{{nonexistent}}` (no substitution) |

## Cross-browser

- [ ] Repeat the §5.2 journeys on the latest Microsoft Edge stable. Sidebar should appear identical; CORS behavior for workflow endpoints should be the same.

## Edge cases

- [ ] 3-hour video (e.g. a TED Talks playlist long-form): subtitle download completes; `{{transcript_with_timestamps}}` uses `[hh:mm:ss]` consistently; workflow request body ≤ 1 MB or whatever your endpoint accepts.
- [ ] Video with both human and ASR caption tracks in the same language: human is selected (verify in DevTools that the timed-text URL used does NOT include `kind=asr`).
- [ ] Video with translatable tracks but no direct-language match: a translation-derived track is selected with `tlang=` appended to the URL.
- [ ] Opening 10 watch tabs in parallel and triggering a workflow in each: each tab has its own subtitle cache (no cross-tab sharing); the service worker handles requests serially without dropping any.
- [ ] Closing a tab mid-fetch: the background releases the per-tab cache (verify in the service worker console).
