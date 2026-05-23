# Subflow

Subflow is a Chrome extension that turns YouTube video subtitles into input for your own AI workflows. The design has no Subflow-controlled backend: subtitles are read on-device, and workflow requests go directly from your browser to whatever HTTPS endpoint you configure.

> **Status**: `v0.1.0` candidate. The end-to-end pipeline — subtitle extraction, caption-track selection, XML parsing, in-memory cache, prompt substitution, HTTP POST runner with timeout / error coverage / service-worker termination replay, manual + auto-run trigger semantics, SPA-driven sidebar lifecycle, options page with workflow CRUD and language priority editor, and Web Store packaging — is implemented and unit-tested. A Chrome Web Store listing has not yet been published; until it is, install via the developer-build steps below. See [`CHANGELOG.md`](./CHANGELOG.md) for the release notes.

## What Subflow does (per [`SPEC.md`](./SPEC.md))

- Detect when you're on a `youtube.com/watch?v=…` page and read the video's subtitles directly from the player data — no audio download, no ASR, no third-party transcript service.
- Let you register HTTP POST endpoints ("workflows") with prompt templates that consume `{{transcript}}`, `{{title}}`, `{{video_id}}`, and the other variables in [Prompt template variables](#prompt-template-variables) below.
- Show a sidebar on every watch page with buttons for your workflows and a list of recent AI responses.
- Optionally auto-run designated workflows the first time a video loads.
- Provide a "Refresh subtitle" button that re-reads captions on demand.

> **About workflow URLs**: per SPEC §7.5, Subflow's manifest only requests `host_permissions: ["https://www.youtube.com/*"]` — that permission lets the background service worker `fetch()` the YouTube timed-text endpoint and lets the static `content_scripts` declarations inject the sidebar / main-world helper into watch pages. Workflow POSTs are sent from the background service worker, which CAN reach any HTTPS URL **without** Subflow declaring that URL in `host_permissions`. The catch: because the workflow request is a non-simple cross-origin POST (`Content-Type: application/json` plus any auth headers you configure), the browser issues a CORS preflight `OPTIONS` request first. The target endpoint must respond to that preflight with, at minimum, `Access-Control-Allow-Origin: chrome-extension://<id>` (or a permissive wildcard), `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers` enumerating `Content-Type` and any custom auth header names you set. Endpoints that can't be configured this way — for instance APIs that strictly reject non-browser origins — are not usable as Subflow workflow targets.

## What Subflow won't do

- Download videos or audio.
- Transcribe (ASR) — if a video has no captions, Subflow says so and stops.
- Sync settings across devices or upload anything to a cloud.
- Custody your API key. Workflow requests POST directly from your browser to the endpoint you configure; the API key only lives in `chrome.storage.local` on your device and the outgoing request headers you wrote. There is no Subflow-controlled proxy in between.
- Maintain conversation history between calls. Each workflow trigger is one stateless POST.

> Important nuance on the "no third-party servers" promise: Subflow's design has no Subflow-controlled server. The two third parties involved in a normal session are YouTube (subtitle fetch, same endpoint the player itself uses) and the workflow URL you choose (an OpenAI-compatible proxy, an n8n webhook, your own server, etc.). See [`PRIVACY.md`](./PRIVACY.md) for the exact data flow.

## Install (developer build, until a Web Store listing is published)

1. Clone the repo:

   ```sh
   git clone https://github.com/hydai/subflow.git
   cd subflow
   ```

2. Install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

3. Open Chrome → `chrome://extensions/`, enable "Developer mode", click "Load unpacked", and select the `dist/` directory the build just produced.

4. Pin the Subflow icon in the toolbar so the options page is one click away.

A Chrome Web Store listing has not yet been published; `npm run package` already produces an upload-ready `subflow-v<version>.zip` (typecheck → test → build → zip, with a manifest/`package.json` version-consistency check).

## How using Subflow works

1. Click the Subflow toolbar icon to open the options page.
2. Set your language preference (e.g. `zh-TW, en`) — these are BCP-47 codes in priority order.
3. Create a workflow with:
   - **Name**: any label you'll recognize in the sidebar.
   - **URL**: an `https://` endpoint that accepts `POST` with `Content-Type: application/json`.
   - **Headers**: any auth headers your endpoint needs (e.g. `Authorization: Bearer …`). The options page rejects a user-supplied `Content-Type` — Subflow always sets it to `application/json`.
   - **Prompt template**: free text with variable placeholders. Common pattern:

     ```
     Summarize this YouTube video. Title: {{title}}. Channel: {{channel}}. Transcript:

     {{transcript}}
     ```

   - **Auto-run**: tick this if you want the workflow to fire automatically when you open a video.
4. Save. Subflow stores the workflow in `chrome.storage.local`; nothing leaves your browser at this step.
5. Open a YouTube video with captions. The sidebar appears, click your workflow's button, and the rendered AI response shows up in the recent-results list.

## Screenshots

UI captures are deferred to a follow-up release; see [`docs/screenshots/`](./docs/screenshots/) for the list of planned screenshots.

## Prompt template variables

| Variable | Always defined? | Content |
| --- | --- | --- |
| `{{transcript}}` | yes | Plain-text transcript, one line per subtitle entry. |
| `{{transcript_with_timestamps}}` | yes | Same, but each line prefixed with `[mm:ss]` or `[hh:mm:ss]`. |
| `{{title}}` | when YouTube reports it | Video title. Pass-through `{{title}}` if absent. |
| `{{channel}}` | when YouTube reports it | Uploader / channel name. Pass-through `{{channel}}` if absent. |
| `{{video_id}}` | yes | YouTube videoId. |
| `{{video_url}}` | yes | `https://www.youtube.com/watch?v=<id>`. |
| `{{language}}` | yes | The matched caption language (your priority-list winner). |
| `{{duration_seconds}}` | when YouTube reports it | Integer length of the video in seconds. Pass-through `{{duration_seconds}}` if absent. |

Unknown or misspelled placeholders are also passed through verbatim. Substituted text is never re-scanned — your transcript can safely contain the literal string `{{transcript}}` without causing a loop.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run build       # produces dist/
npm run package     # typecheck + test + build + zip
```

Tests live in `tests/`. The full specification is in [`SPEC.md`](./SPEC.md); each GitHub Issue maps to a section of the SPEC and a milestone.

## License

[MIT](./LICENSE).
