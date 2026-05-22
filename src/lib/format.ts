// Subtitle timestamp formatter per SPEC §7.3.
//
// `useHours` is decided once per video (based on whether the total
// duration is ≥ 60 minutes or unknown) and applied to every line so
// the format stays consistent within a single transcript. The function
// itself is timestamp-by-timestamp; the per-video decision belongs to
// the caller. When `useHours` is true the hh field naturally extends
// past two digits (`100:00:00`), never truncating; the same natural
// extension applies to the mm field in mm:ss mode if a caption start
// happens to be ≥ 60 minutes despite the duration metadata saying
// otherwise (so 3600s renders as `60:00`, not the collapsed `00:00`).

export function formatTimestamp(seconds: number, useHours: boolean): string {
  const s = seconds % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");

  if (useHours) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds / 60) % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  const m = Math.floor(seconds / 60);
  return `${pad2(m)}:${pad2(s)}`;
}
