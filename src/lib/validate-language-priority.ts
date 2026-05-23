// Pure validation for the options-page language-priority editor
// (SPEC §6.8 / §7.4).
//
// Returns the sanitized form (trimmed, original-case preserved)
// AND any user-facing errors. The UI consumes both — sanitized
// values go into storage on success, errors flow into the inline
// banner next to the language section on failure.
//
// SPEC §7.4 rules:
//   - Every entry is trimmed before storage; whitespace-only entries
//     count as MISSING (a blank row the user forgot to fill in)
//     and BLOCK the save with an inline error per SPEC §7.6.
//     Silently dropping them would hide partial saves from the user.
//   - The list must contain at least one non-empty code.
//   - Original case is preserved — SPEC §6.1 makes matching
//     case-insensitive, so we don't normalize here. A user typing
//     `zh-TW` should see `zh-TW` round-trip, not `zh-tw`.
//   - We deliberately do NOT enforce BCP-47 syntax; that would
//     reject rare or future-defined codes. The matcher in #5
//     handles unknown codes by simply not matching.

export interface LanguagePriorityValidationResult {
  // Trimmed values with original case preserved. Always returned so
  // callers can surface the "preview" form to the user even when
  // validation fails (e.g. show that `  zh-TW  ` would persist as
  // `zh-TW`).
  trimmed: string[];
  // Top-level errors that prevent saving the list as a whole
  // (empty list, missing-at-position-N). Empty array means OK.
  errors: LanguagePriorityValidationError[];
}

export interface LanguagePriorityValidationError {
  // 0-indexed row pointer for per-row errors; undefined for
  // whole-list errors. The UI uses this to anchor the message to
  // the row that failed.
  index?: number;
  message: string;
}

export function validateLanguagePriority(
  codes: readonly string[],
): LanguagePriorityValidationResult {
  const trimmed = codes.map((s) => s.trim());
  const errors: LanguagePriorityValidationError[] = [];

  if (trimmed.length === 0) {
    errors.push({ message: "至少需設定一個語言偏好" });
    return { trimmed, errors };
  }

  // Per-row blank check. Even one blank row blocks save: silently
  // dropping it would mask a user typo (they meant to type a code
  // but forgot).
  trimmed.forEach((s, idx) => {
    if (s.length === 0) {
      errors.push({
        index: idx,
        message: `第 ${idx + 1} 列語言代碼為空，請填入或移除空列`,
      });
    }
  });

  // If every entry was blank, the per-row errors above already
  // covered each row, but the user also needs a top-level message
  // explaining the at-least-one rule. (validate-and-block-on-empty
  // earlier covers length === 0; here we cover "length > 0 but all
  // blank".)
  if (errors.length === trimmed.length) {
    errors.push({ message: "至少需設定一個語言偏好" });
  }

  return { trimmed, errors };
}
