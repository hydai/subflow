# Changelog

All notable changes to Subflow are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Background subtitle pipeline: player-response extraction, caption-track selection (with translation derivation), timed-text XML parsing, tab-scoped in-memory cache with in-flight dedup and epoch-guarded invalidation, and a YouTube origin-allowlisted fetch helper that omits credentials.
- Workflow HTTP POST runner: 60-second AbortController-enforced timeout (armed until the response body is fully read), 4xx/5xx body truncation to 2000 chars per SPEC §7.6, typed `WorkflowResult` outcomes for success/http-error/timeout/network-error.
- Content-script bridge: main-world `ytInitialPlayerResponse` extractor + isolated-world postMessage forwarder + SPA-driven re-extraction on `yt-navigate-finish` so SPA video switches don't strand the background with stale player data.
- Sidebar lifecycle skeleton: closed-mode Shadow DOM root injected on `/watch` and removed elsewhere. Real renderer lands in [#12](https://github.com/hydai/subflow/issues/12).
- `chrome.storage.local` wrapper with typed `Result<T, E>` failure surface for `QUOTA_EXCEEDED` / `STORAGE_API_ERROR` and a `schemaVersion: 1` stamp for forward-compatible migrations.
- Prompt-template `{{var}}` substitution with single-pass ECMAScript semantics; unknown / undefined variables pass through verbatim.
- Project documentation: README, PRIVACY, LICENSE (MIT), and a deterministic SVG-path icon generator.
- `npm run package` chains typecheck → test → build → zip via `archiver`; verifies that `dist/manifest.json` and `package.json` agree on version before producing `subflow-v<version>.zip`.

### Known not-yet-implemented

The visible options page UI ([#9](https://github.com/hydai/subflow/issues/9), [#10](https://github.com/hydai/subflow/issues/10)), the sidebar renderer ([#12](https://github.com/hydai/subflow/issues/12)), the sidebar collapse / cross-video state behavior ([#13](https://github.com/hydai/subflow/issues/13)), the workflow trigger semantics ([#16](https://github.com/hydai/subflow/issues/16)), and the user-visible error surfaces for subtitle ([#17](https://github.com/hydai/subflow/issues/17)) and workflow ([#18](https://github.com/hydai/subflow/issues/18)) failures are still in progress. Subflow is not yet end-to-end functional from a user's perspective; the merged work is the internal pipeline that those UI layers will plug into.

## [0.1.0] — TBD

First public release will be cut after the issues listed under "Known not-yet-implemented" are merged. Until then, this CHANGELOG accumulates entries under `[Unreleased]`.

[Unreleased]: https://github.com/hydai/subflow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hydai/subflow/releases/tag/v0.1.0
