# Privacy

Subflow has no Subflow-controlled backend, no analytics, and no telemetry. The extension code runs entirely inside your browser, sees your subtitles and prompt bodies, and sends them only to the YouTube subtitle endpoint and the workflow URL you yourself configured. Because the maintainer doesn't operate a server in this picture, the maintainer has no way to read what your browser is sending or receiving.

A maintainer can, however, ship new extension code in a future Chrome Web Store update. If a hostile update slipped past Chrome's review and was installed on your machine, that code would in principle have access to the same in-browser data the current extension does. The protections that follow are the contract enforced by the *current* code and reaffirmed in the SPEC; verifying any particular release matches that contract is what makes the source-available, MIT-licensed codebase auditable.

This document describes exactly what data Subflow touches, where each piece lives, and who could see it. It mirrors the guarantees in `SPEC.md` §3 (Impacts) and §4 (Non-goals); when in doubt the SPEC is authoritative.

> **Status**: this is the privacy contract for Subflow's design. Some user-visible surfaces are still under construction (the options page and sidebar UI); the data-flow rules below already apply to the implemented background / content-script pipeline and constrain everything that lands afterwards.

## No backend

Subflow has no backend infrastructure. There is no Subflow-controlled server that ever sees your subtitles, prompts, AI responses, workflow definitions, or API keys.

All extension code runs inside your browser. Updates come from the Chrome Web Store (or your `chrome://extensions/` "load unpacked" install); no Subflow server pushes code or settings.

## What Subflow stores on your machine

- **Workflow definitions** — name, URL, prompt template, headers (typically including your API key), and the `autoRun` flag. Stored in `chrome.storage.local`.
- **Language preference** — your ordered list of BCP-47 language codes. Stored in `chrome.storage.local`.
- **Per-tab in-memory caches** — the parsed subtitle for the videos you've viewed in that tab, plus a recent-results list of up to five workflow outputs. Lives only for the lifetime of the tab; closing it discards everything.

`chrome.storage.local` is sandboxed per-extension on your device. Subflow does not enable Chrome Sync for this storage, so settings do not propagate to other devices or other Chrome profiles you sign into.

## What Subflow sends over the network

Two kinds of requests, both initiated by your browser:

1. **YouTube subtitle download.** When you visit a watch page, the extension's background service worker fetches the subtitle XML directly from `https://www.youtube.com/api/timedtext?…` (the URL is the same one YouTube itself uses; Subflow does not invent it). The request goes from your browser to YouTube. Subflow does not add cookies, custom headers, or your identity in any form beyond what Chrome's standard HTTP stack would attach (`credentials: "omit"` is set so YouTube cookies are NOT included). Subflow does not relay this through any third party.
2. **Workflow request.** When a workflow fires (manually or auto-run), the background service worker POSTs to the URL you configured, with the headers you configured, and a JSON body of the form `{ "prompt": "<your prompt template after variable substitution>" }`. The request goes directly from your browser to that endpoint. The Subflow extension code obviously constructs the body and reads the response (it has to — there's no other way to render the result in the sidebar), and it keeps the response body in the per-tab in-memory recent-results list until the tab closes or the list overflows past five entries. What Subflow does NOT do: ship the prompt or the response to any Subflow-controlled server (there is none), log them to disk, persist them across browser sessions, or copy them anywhere outside that tab's in-memory state.

These are the only network requests Subflow generates. The extension does not "phone home," ship telemetry, send analytics, or contact any other host.

## API keys

You set API keys (or any other authentication secrets) as part of the workflow's `headers` field on the options page. They are stored in `chrome.storage.local` on your device. Subflow does not synchronize these to any cloud, transmit them to any Subflow-controlled service (there is none), or read them outside the context of the workflow request that uses them.

The keys are accessible to the Subflow extension code (and to anyone with physical or root access to your browser profile, the same as any other Chrome extension's local storage). If you want to revoke a key's exposure to Subflow, delete the workflow that uses it.

## Permissions Subflow asks for, and why

The manifest declares exactly:

- `storage` — needed to read and write workflow / language settings to `chrome.storage.local`.
- `scripting` — declared per SPEC §7.5 as a reserved permission for future dynamic script-injection paths (e.g. `chrome.scripting.executeScript`). The current implementation does not actually invoke any `chrome.scripting.*` API; static `content_scripts` declarations in `manifest.json` handle injection. If a future release ships without exercising this permission, it should be removed from the manifest.
- `host_permissions: ["https://www.youtube.com/*"]` — needed to read subtitles from YouTube and to inject the sidebar.

Subflow explicitly does **not** request `tabs`, `cookies`, `<all_urls>`, `history`, or `downloads`. SPEC §7.5 enumerates this; a test in `tests/manifest.test.ts` verifies the manifest stays this way.

Workflow POSTs to user-configured URLs do NOT require an additional `host_permissions` entry. Chrome MV3 background service workers can issue `fetch()` to any HTTPS origin; the target endpoint is reachable as long as it returns CORS headers permitting Subflow's `chrome-extension://<id>` origin. In practice this means the target endpoint must answer a CORS preflight `OPTIONS` request with `Access-Control-Allow-Origin: chrome-extension://<id>` (or a wildcard), `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers` listing `Content-Type` and any auth header names the workflow configures. The user approves the workflow URL once in the options page; it is never elevated into a host permission, so the extension's reach is bounded by the receiving server's CORS contract rather than by anything Subflow grants itself.

## Subtitle data

Subtitle text comes directly from YouTube's player response on the page you're watching. Subflow parses it locally and feeds it into your prompt template. The transcript is sent to the endpoint **you** configured as part of the workflow request body; it is never sent anywhere else.

## Telemetry, analytics, crash reports

None. Subflow has no analytics SDK, no crash reporter, no usage counter, and no remote logging.

## Third parties

The two third parties involved are the ones you've already chosen to involve:

- **YouTube** sees your normal browsing activity (and now, additionally, the subtitle endpoint fetch — though that endpoint is the same one the YouTube player itself uses).
- **The workflow endpoint(s) you configure** see the prompt body Subflow POSTs and any headers (including your API key, if you configured one).

That's the full list. There are no Subflow-controlled intermediaries.

## Reporting issues

If you find a behavior that conflicts with this statement, please file an issue at <https://github.com/hydai/subflow/issues>. Privacy-affecting bugs are treated as P0.
