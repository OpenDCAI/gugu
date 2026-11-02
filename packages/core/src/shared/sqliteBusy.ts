/** Drizzle can retain the native SQLite result on a cause rather than the outer error. */
export function isSqliteBusy(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const { code, cause } = error as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code)) return true
    error = cause
  }
  return false
}
