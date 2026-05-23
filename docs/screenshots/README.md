# Screenshots

This directory is reserved for UI captures of the Subflow Chrome extension. Captures should be PNGs taken at 1× device pixel ratio against a freshly-loaded Chrome profile with only Subflow enabled (no other extensions in the toolbar to avoid leaking unrelated icons).

Planned captures (CTA presence per status matches `renderSubtitleCta` in [`src/content/index.ts`](../../src/content/index.ts)):

- `options.png` — the options page with at least one saved workflow and a non-empty language priority list.
- `sidebar-ready.png` — the watch-page sidebar after the subtitle has loaded successfully, with two or three workflow buttons visible and one recent result in the results list.
- `sidebar-collapsed.png` — the same sidebar in its collapsed state, showing the collapse-toggle affordance.
- `sidebar-error-missing-language-priority.png` — the sidebar showing the `missing-language-priority` status with the "Open settings" CTA visible (reproduce by clearing the language priority list before opening any watch page).
- `sidebar-error-no-subtitle.png` — the sidebar showing the `no-subtitle` status message with no CTA (reproduce on a watch URL where YouTube has not exposed caption tracks; `no-subtitle` and `live-or-premiere` deliberately have no remedial action).
- `sidebar-error-fetch-failed.png` — the sidebar showing `fetch-failed` with the "Retry" CTA. `fetch-failed` covers both network errors and non-2xx HTTP responses from the timed-text endpoint (see `fetchSubtitleXml` in [`src/background/fetch-subtitle.ts`](../../src/background/fetch-subtitle.ts)); reproduce either by going offline in DevTools → Network or blocking the timed-text URL via "Block request URL", or by forcing a non-2xx response with a request-override tool (a local proxy such as Charles / mitmproxy, or a DevTools override). Plain network throttling causes timeouts rather than `fetch-failed`, so don't use it for this capture.
- `sidebar-result-error.png` — the recent-results list with one entry in a retryable workflow outcome (e.g. `http-error 503`) and the Retry button visible. Distinct from the subtitle-error captures: this Retry lives on the workflow-result row, not under the subtitle status banner.

Captures are deferred to a follow-up; until they exist, this README serves as the placeholder. When adding screenshots, also reference them from the main [`README.md`](../../README.md) so they show up in the GitHub repo landing view.
