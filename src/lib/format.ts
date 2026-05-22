// Subtitle timestamp formatter per SPEC §7.3.
//
// `useHours` is decided once per video (based on whether the total
// duration is ≥ 60 minutes or unknown) and applied to every line so
// the format stays consistent within a single transcript. The function
// itself is timestamp-by-timestamp; the per-video decision belongs to
// the caller. When `useHours` is true the hh field naturally extends
// past two digits (`100:00:00`), never truncating.

export function formatTimestamp(seconds: number, useHours: boolean): string {
  const s = seconds % 60;
  const m = Math.floor(seconds / 60) % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");

  if (useHours) {
    const h = Math.floor(seconds / 3600);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }
  return `${pad2(m)}:${pad2(s)}`;
}
