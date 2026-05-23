# Screenshots

This directory is reserved for UI captures of the Subflow Chrome extension. Captures should be PNGs taken at 1× device pixel ratio against a freshly-loaded Chrome profile with only Subflow enabled (no other extensions in the toolbar to avoid leaking unrelated icons).

Planned captures:

- `options.png` — the options page with at least one saved workflow and a non-empty language priority list.
- `sidebar-ready.png` — the watch-page sidebar after the subtitle has loaded successfully, with two or three workflow buttons visible and one recent result in the results list.
- `sidebar-collapsed.png` — the same sidebar in its collapsed state, showing the collapse-toggle affordance.
- `sidebar-error-no-subtitle.png` — the sidebar showing the `no-subtitle` status message and the "Open Settings" CTA (any watch URL where YouTube has not exposed caption tracks).
- `sidebar-result-error.png` — the recent-results list with one entry in an error outcome (e.g. `http-error 503`) and the Retry button visible.

Captures are deferred to a follow-up; until they exist, this README serves as the placeholder. When adding screenshots, also reference them from the main [`README.md`](../../README.md) so they show up in the GitHub repo landing view.
