const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human-readable byte size.
 *
 * Two traps this deliberately avoids:
 *
 * 1. **Rounding can carry past the unit.** Picking the unit before rounding
 *    lets a value just under the boundary print in the smaller one:
 *    1_048_570 bytes is 1023.99 KB, which `toFixed(1)` renders as
 *    `"1024.0 KB"` — the exact "too many digits" shape the unit scaling
 *    exists to prevent. The rounded value is re-checked against the boundary.
 * 2. **Whole bytes are whole.** `"10.0 B"` invents precision that a byte
 *    count does not have.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  // Re-check after rounding: 1023.99 KB must print as 1.0 MB, not 1024.0 KB.
  if (unitIndex < UNITS.length - 1 && Number(size.toFixed(1)) >= 1024) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${UNITS[unitIndex]}`;
}
