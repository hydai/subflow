// Single-pass `{{var}}` substitution per SPEC §7.3.
//
// The implementation is one `String.prototype.replace(regex, fn)`
// call. Per the ECMAScript spec, when `replace` is invoked with a
// global regex and a function, the engine invokes the function once
// per match using indexes into the ORIGINAL string — so substituted
// text is never re-scanned (a transcript that happens to contain
// `{{transcript}}` survives verbatim). Unknown variables and
// variables whose value is `undefined` leave the original
// placeholder in place (`{{xxx}}`), per SPEC §6.6 "未定義變數原樣
// 保留" and §7.3 "videoDetails 對應欄位缺失時視為未定義".

import type { PromptVariables } from "./types";

// `{{key}}` where key is at least one word character (letters, digits,
// underscores). Empty placeholders (`{{}}`) and any non-conforming
// content between the braces are left alone, which matches the
// "single, well-known variable set" semantics — only the documented
// names are substitution-eligible.
const VARIABLE_RE = /{{(\w+)}}/g;

// Known variable names: the keys of PromptVariables. Anything outside
// this set is treated as undefined (passthrough), even if the caller
// somehow stuffed it into the vars object.
const KNOWN_VARIABLES: ReadonlySet<keyof PromptVariables> = new Set<keyof PromptVariables>([
  "transcript",
  "transcript_with_timestamps",
  "title",
  "video_id",
  "video_url",
  "channel",
  "language",
  "duration_seconds",
]);

export function substitute(template: string, vars: PromptVariables): string {
  return template.replace(VARIABLE_RE, (match, rawKey: string) => {
    if (!KNOWN_VARIABLES.has(rawKey as keyof PromptVariables)) {
      return match;
    }
    const value = vars[rawKey as keyof PromptVariables];
    if (value === undefined) return match;
    // `duration_seconds` is a number; everything else is already a
    // string. Use `String(...)` so 0 renders as "0" rather than
    // coalescing to undefined via truthiness checks.
    return String(value);
  });
}
