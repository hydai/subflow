// Caption-track selection per SPEC §6.1.2 + §6.1.3.
//
// Pure function. The outer dimension is the user's BCP-47 language
// priority list (decided independently per language); the inner
// dimension is source preference within a single language:
//
//   1. Direct match: a track whose `languageCode` matches the
//      preferred language case-insensitively. Within the matches,
//      `human > auto` wins; the original casing of the track's
//      `languageCode` is preserved on the way out.
//
//   2. Translation derivation: if no direct match exists for the
//      preferred language, but the track list contains any track
//      with `isTranslatable: true`, the highest-priority translatable
//      track (`human > auto`, then lowest array index) is reused with
//      `tlang=<preferred language>` appended/overwritten on its
//      `baseUrl`. The result's `languageCode` is the appended `tlang`
//      value (i.e. the preferred language code as the user typed it),
//      and the source is `"translation"`.
//
// The first preferred language with ANY result wins; we do NOT keep
// searching subsequent languages once a language has decided.

import type { CaptionSource, CaptionTrack, SelectedTrack } from "./types";

export function selectTrack(
  tracks: CaptionTrack[],
  languagePriority: string[],
): SelectedTrack | null {
  if (tracks.length === 0 || languagePriority.length === 0) return null;

  for (const preferredLanguage of languagePriority) {
    const direct = findDirectMatch(tracks, preferredLanguage);
    if (direct) return direct;

    const translated = findTranslationMatch(tracks, preferredLanguage);
    if (translated) return translated;
  }
  return null;
}

function findDirectMatch(
  tracks: CaptionTrack[],
  preferredLanguage: string,
): SelectedTrack | null {
  const target = preferredLanguage.toLowerCase();
  let human: CaptionTrack | null = null;
  let auto: CaptionTrack | null = null;
  for (const track of tracks) {
    if (track.languageCode.toLowerCase() !== target) continue;
    if (track.kind === "asr") {
      if (auto === null) auto = track;
    } else {
      if (human === null) human = track;
    }
  }
  const chosen = human ?? auto;
  if (chosen === null) return null;
  const source: CaptionSource = chosen.kind === "asr" ? "auto" : "human";
  return {
    baseUrl: chosen.baseUrl,
    languageCode: chosen.languageCode,
    source,
  };
}

function findTranslationMatch(
  tracks: CaptionTrack[],
  preferredLanguage: string,
): SelectedTrack | null {
  let humanIndex = -1;
  let autoIndex = -1;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]!;
    if (!t.isTranslatable) continue;
    if (t.kind === "asr") {
      if (autoIndex === -1) autoIndex = i;
    } else {
      if (humanIndex === -1) humanIndex = i;
    }
  }
  const chosenIndex = humanIndex !== -1 ? humanIndex : autoIndex;
  if (chosenIndex === -1) return null;
  const source = tracks[chosenIndex]!;

  // YouTube delivers absolute https://… URLs, but `extractPlayerData`
  // only verifies that `baseUrl` is a string. If the value is malformed
  // (site change, unexpected input) `new URL` would throw and crash
  // selection. Skip translation derivation for this track in that case
  // — the outer loop falls through to the next preferred language.
  let url: URL;
  try {
    url = new URL(source.baseUrl);
  } catch {
    return null;
  }
  url.searchParams.set("tlang", preferredLanguage);

  return {
    baseUrl: url.toString(),
    languageCode: preferredLanguage,
    source: "translation",
  };
}
