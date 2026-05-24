/**
 * Renders a simple aligned text table — column widths are auto-derived from the
 * widest cell in each column (headers included). Cells are padded right with spaces
 * and joined with a two-space gap. The last column is not padded to avoid trailing
 * whitespace on each row.
 *
 * Cells are taken verbatim; callers should truncate long strings via {@link truncate}
 * before passing them in if they want bounded column widths.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const allRows: readonly (readonly string[])[] = [headers, ...rows];
  const widths = headers.map((_, colIdx) =>
    Math.max(...allRows.map(row => (row[colIdx] ?? "").length)),
  );

  return allRows
    .map(row =>
      row
        .map((cell, i) => {
          if (i === headers.length - 1) return cell;
          return cell.padEnd(widths[i] ?? 0);
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Truncates `value` to at most `max` characters, appending `...` when truncation
 * actually happens. The ellipsis counts toward `max`, so a `max` of 10 leaves at
 * most 7 visible characters of the original.
 *
 * For `max <= 3`, the string is hard-clipped without an ellipsis — there's not
 * enough room to convey both information and the "truncated" hint.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

/**
 * Humanizes a duration in seconds into a short, scannable label suitable for table
 * cells and log lines. Examples: `"42s"`, `"5m"`, `"2h 30m"`, `"3d 4h"`, `"expired"`.
 *
 * A negative value is rendered as `"expired"` rather than a negative number — the
 * caller wants to communicate "no longer valid", not an arithmetic curiosity.
 */
export function humanizeDuration(seconds: number): string {
  if (seconds < 0) return "expired";
  if (seconds < 60) return `${Math.floor(seconds)}s`;

  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remainingMinutes > 0 ? `${totalHours}h ${remainingMinutes}m` : `${totalHours}h`;
  }

  const totalDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return remainingHours > 0 ? `${totalDays}d ${remainingHours}h` : `${totalDays}d`;
}
