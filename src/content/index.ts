// Subflow content script entry.
// Real behavior is delivered by later issues (e.g. #4, #11, #12).
//
// content.js is loaded by Chrome as a classic script (the
// `content_scripts` entry in manifest.json does not set `"type":
// "module"`), so the emitted bundle must contain no ESM module syntax
// — neither `import` nor `export`. The bare `export {}` below is a
// TypeScript-only marker that satisfies `isolatedModules`; Rollup
// strips it from the bundled output because it has no remaining
// semantic effect. Do not add real `import`/`export` statements here
// until the build is split into per-entry Vite invocations (see the
// MV3 caveat in vite.config.ts).

export {};
