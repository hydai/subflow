# Subflow

Subflow is a Chrome extension that turns YouTube video subtitles into input for your own AI workflows. No backend, no third-party servers, no API keys leaving your machine.

## What it does

- Detects when you're on a `youtube.com/watch?v=…` page and reads the video's subtitles directly from the player data — no audio download, no ASR, no third-party transcript service.
- Lets you register HTTP POST endpoints ("workflows") with prompt templates that consume `{{transcript}}`, `{{title}}`, `{{video_id}}`, and other variables.
- Shows a sidebar on every watch page with buttons for your workflows and a list of recent AI responses.
- Optionally auto-runs designated workflows the first time a video loads.
- "Refresh subtitle" button re-reads the captions if you suspect them stale or you changed your language preference.

## What it doesn't do

- Download videos or audio.
- Transcribe (ASR) — if a video has no captions, Subflow says so and stops.
- Sync settings across devices or upload anything to a cloud.
- Hold your API key on any Subflow-controlled server. Workflows go directly from your browser to whatever endpoint you configured.
- Maintain conversation history between calls. Each workflow trigger is one stateless POST.

See [`SPEC.md`](./SPEC.md) for the complete specification.

## Privacy

Read [`PRIVACY.md`](./PRIVACY.md) for the full statement. The short version: Subflow has no backend and never sends your data anywhere you didn't explicitly configure.

## Install

### From source (until a Web Store listing is published)

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

### From the Chrome Web Store

Planned, not yet available. The bundling and store assets are tracked in [#20](https://github.com/hydai/subflow/issues/20).

## Configure your first workflow

1. Click the Subflow toolbar icon to open the options page.
2. Set your language preference (e.g. `zh-TW, en`) — these are BCP-47 codes in priority order.
3. Click "New workflow" and fill in:
   - **Name**: any label you'll recognize in the sidebar.
   - **URL**: an `https://` endpoint that accepts `POST` with `Content-Type: application/json`. Examples: a self-hosted FastAPI gateway, an n8n / Make webhook, an OpenAI-compatible proxy.
   - **Headers**: any auth headers your endpoint needs (e.g. `Authorization: Bearer …`). Do not include `Content-Type` — Subflow sets it.
   - **Prompt template**: free text with variable placeholders. Common pattern:

     ```
     Summarize this YouTube video. Title: {{title}}. Channel: {{channel}}. Transcript:

     {{transcript}}
     ```

   - **Auto-run**: tick this if you want the workflow to fire automatically each time you open a new video.
4. Save. Subflow stores the workflow in `chrome.storage.local`; nothing leaves your browser at this step.

## Run a workflow

1. Open a YouTube video with captions.
2. The Subflow sidebar appears on the right edge of the player.
3. Click your workflow button. Subflow:
   - Reads the video's subtitle data from YouTube's `ytInitialPlayerResponse`.
   - Substitutes variables into your prompt template.
   - POSTs `{ "prompt": "<final prompt>" }` to your endpoint with your headers.
   - Shows the response (or error) in the sidebar's results list.

The five most recent results stick around per tab. Switching to a new video resets the list but keeps the sidebar open.

## Prompt template variables

| Variable | Content |
| --- | --- |
| `{{transcript}}` | Plain-text transcript, one line per subtitle entry. |
| `{{transcript_with_timestamps}}` | Same, but each line prefixed with `[mm:ss]` or `[hh:mm:ss]`. |
| `{{title}}` | Video title. |
| `{{channel}}` | Uploader / channel name. |
| `{{video_id}}` | YouTube videoId. |
| `{{video_url}}` | `https://www.youtube.com/watch?v=<id>`. |
| `{{language}}` | The matched caption language (your priority list winner). |
| `{{duration_seconds}}` | Integer length of the video in seconds. |

Unknown or misspelled placeholders are left in the output verbatim. Substituted text is never re-scanned — your transcript can safely contain the literal string `{{transcript}}` without causing a loop.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run build       # produces dist/
npm run package     # typecheck + test + build + zip
```

Tests live in `tests/`. Issue trackers, scope, and acceptance criteria are in this repo's GitHub Issues — every issue maps to a section of [`SPEC.md`](./SPEC.md).

## License

MIT — see [`LICENSE`](./LICENSE) if present, otherwise consider this notice the license grant.
