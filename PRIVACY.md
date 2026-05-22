# Privacy

Subflow is designed so that the extension developer (and any future maintainer) has no technical ability to see your data — there's nothing for us to leak because nothing flows through us.

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
2. **Workflow request.** When a workflow fires (manually or auto-run), the background service worker POSTs to the URL you configured, with the headers you configured, and a JSON body of the form `{ "prompt": "<your prompt template after variable substitution>" }`. The request goes directly from your browser to that endpoint. Subflow does not see it, log it, retain it, or copy it anywhere.

These are the only network requests Subflow generates. The extension does not "phone home," ship telemetry, send analytics, or contact any other host.

## API keys

You set API keys (or any other authentication secrets) as part of the workflow's `headers` field on the options page. They are stored in `chrome.storage.local` on your device. Subflow does not synchronize these to any cloud, transmit them to any Subflow-controlled service (there is none), or read them outside the context of the workflow request that uses them.

The keys are accessible to the Subflow extension code (and to anyone with physical or root access to your browser profile, the same as any other Chrome extension's local storage). If you want to revoke a key's exposure to Subflow, delete the workflow that uses it.

## Permissions Subflow asks for, and why

The manifest declares exactly:

- `storage` — needed to read and write workflow / language settings to `chrome.storage.local`.
- `scripting` — needed to inject the content script and main-world helper into YouTube watch pages.
- `host_permissions: ["https://www.youtube.com/*"]` — needed to read subtitles from YouTube and to inject the sidebar.

Subflow explicitly does **not** request `tabs`, `cookies`, `<all_urls>`, `history`, or `downloads`. SPEC §7.5 enumerates this; a test in `tests/manifest.test.ts` verifies the manifest stays this way.

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
