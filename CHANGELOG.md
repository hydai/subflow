# Changelog

All notable changes to Subflow are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-23

First release. The full SPEC.md scope (issues #1–#20) is implemented. The core extraction, runner, storage, prompt-substitution, content-bridge, orchestrator, and validator modules are covered by the unit tests in [`tests/`](./tests/); the UI render layer and the packaging step are exercised manually via [`docs/qa-checklist.md`](./docs/qa-checklist.md). No Chrome Web Store listing yet; install via the developer-build steps in [`README.md`](./README.md).

### Added — background pipeline

- Player-data extractor: reads `ytInitialPlayerResponse` from the watch-page main world and forwards it to the background via the isolated-world content-script bridge.
- Caption-track selector: priority-list match with translation derivation (`tlang=`) when no direct track exists; preserves YouTube's original casing for the matched language code.
- Timed-text XML parser: emits a plain-text transcript and a timestamped transcript with a per-video `[mm:ss]` / `[hh:mm:ss]` format chosen once based on duration.
- Tab-scoped subtitle cache with in-flight dedup, epoch-guarded invalidation across SPA video switches, and an MRU eviction key set so prompt-variable assembly can find the cached entry by `videoId`.
- YouTube origin-allowlisted fetch helper that omits credentials and refuses non-YouTube URLs.

### Added — workflow runner

- HTTP POST workflow runner with a 60-second `AbortController`-enforced timeout that stays armed until the response body is fully read (per SPEC §7.6).
- 4xx / 5xx body truncation to 2000 characters; 2xx bodies returned in full.
- Typed `WorkflowResult` outcomes: `success`, `http-error`, `network-error`, `timeout`, `aborted`, `precondition-failed`, `interrupted`.
- Trigger semantics: manual button trigger plus first-visit `autoRun` dedup keyed on `(videoId, workflowId)`; SPA-driven abort via an `externalSignal` so a video switch cancels the in-flight request without leaking the result back to the new video.
- Service-worker termination detection: in-flight requests are recorded in a `chrome.storage.local` scratchpad (`subflow.inFlightWorkflows`) with a 24-hour TTL; on next service-worker wake a `replayInterruptedWorkflows` pass surfaces an `interrupted` result to any sidebar that's still listening.

### Added — content scripts & sidebar

- Static `content_scripts` declarations for both an isolated-world bridge and a `world: "MAIN"` extractor; SPA re-extraction is wired through a postMessage tag (`subflow:request-reextraction`) so navigating between videos does not strand the background with stale player data.
- Closed-mode Shadow DOM sidebar root injected on `/watch` and removed elsewhere; the captured root reference is held by the content script so YouTube DOM mutations cannot un-mount it.
- Sidebar UI: subtitle status banner with specific messages per outcome (`no-subtitle`, `live-or-premiere`, `missing-language-priority`, `fetch-failed`, `parse-failed`); workflow button row gated on subtitle readiness; recent-results list capped at 5 entries with most-recent-first ordering.
- Sidebar collapse toggle: in-place class flip preserves focus and the scroll position; collapsed state persists across SPA video switches.
- Per-result Retry button: enabled for `http-error` (5xx), `timeout`, `network-error`, `precondition-failed`, and `interrupted`; disabled when the subtitle is not yet ready.
- "Open Settings" CTA relayed via `subflow:open-options-page` when the user has not yet configured a language priority.
- Request-id-based dedup with an upgrade path: a `network-error` placeholder is replaced in place when the corresponding `interrupted` replay arrives.

### Added — options page

- Workflow CRUD with shape repair for recoverable storage drift and a serialized persist queue (`enqueuePersist` with `queuedNext` / `inFlightNext`) that coalesces rapid edits while keeping order correct.
- Language priority editor with live validation (BCP-47 trim, blank-row counter, "at least one entry" message) and a tagged banner state for save / load / repair feedback.
- Case-insensitive `Content-Type` rejection both at save time and at workflow-request time so the runtime always sends `application/json`.

### Added — storage

- `chrome.storage.local` wrapper returning a typed `Result<T, E>` for `QUOTA_EXCEEDED` / `STORAGE_API_ERROR` and stamping a `schemaVersion: 1` envelope for forward-compatible migrations.

### Added — prompt templates

- `{{var}}` substitution with single-pass ECMAScript semantics; unknown / undefined variables pass through verbatim, and substituted text is never re-scanned (a transcript containing the literal `{{transcript}}` does not loop).

### Added — packaging & docs

- `npm run package` chains typecheck → test → build → zip via `archiver` and verifies that `dist/manifest.json` and `package.json` agree on version before producing `subflow-v<version>.zip`.
- Deterministic SVG-path icon generator (`scripts/make-icons.mjs` via `sharp`) producing 16 / 32 / 48 / 128 px PNGs from a single source.
- Manual QA checklist (`docs/qa-checklist.md`) covering install, watch-page sidebar, options page CRUD, language priority editing, workflow request errors, and service-worker termination replay.
- Project documentation: [`README.md`](./README.md), [`PRIVACY.md`](./PRIVACY.md), and [`LICENSE`](./LICENSE) (MIT).

### Known limitations

- Screenshots of the options page and sidebar are not yet captured; the `docs/screenshots/` directory holds a placeholder describing what should live there.
- No Chrome Web Store listing yet; the upload-ready zip is produced by `npm run package` but has not been submitted.

[0.1.0]: https://github.com/hydai/subflow/releases/tag/v0.1.0
<!--
The `v0.1.0` git tag has not yet been pushed. After this CHANGELOG
lands on main, run `git tag v0.1.0` and `git push origin v0.1.0`
(and optionally publish a GitHub Release) so the link above
resolves. When work on the next version begins, add a new
`## [Unreleased]` section above and a matching
`[Unreleased]: .../compare/v0.1.0...HEAD` line below.
-->
