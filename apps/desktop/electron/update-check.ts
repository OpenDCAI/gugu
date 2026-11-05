// Asking the feed for an update: the user's 「检查更新」 (an RPC that answers) and the automatic checks (timers with
// nobody to answer to). Updater events publish the result, including progress started by update-available; a query
// returns that same stamped state instead of inventing a second result (#1342).

/** First automatic check after launch, then every half hour. */
export const AUTO_UPDATE_INITIAL_DELAY_MS = 10 * 1000
export const AUTO_UPDATE_INTERVAL_MS = 30 * 60 * 1000

export type UpdatePolicy<Disabled> = { enabled: true } | ({ enabled: false } & Disabled)

export interface UpdateCheckHost<State, Disabled> {
  /** Whether this build may check at all; when it may not, the check answers with the blocked state. */
  policy: () => UpdatePolicy<Disabled>
  /** Logs why a check was blocked and publishes the blocked state. */
  blocked: (policy: { enabled: false } & Disabled) => State
  /** The feed query itself (electron-updater's checkForUpdates). */
  query: () => Promise<unknown>
  /** The state the updater events have published by now. */
  current: () => State
  warn: (message: string, detail: string) => void
  /** Automatic checks run only in a real session (not under the test harness). */
  automatic: boolean
  setTimeout?: (run: () => void, ms: number) => unknown
  setInterval?: (run: () => void, ms: number) => unknown
}

export interface UpdateChecks<State> {
  /** The user's check: rejects with the feed's own error, and leaves live progress as it is. */
  check: () => Promise<State>
  /** Start the automatic checks. A failed automatic check warns and is dropped: no unhandled rejection. */
  startAutomatic: () => void
}

export function createUpdateChecks<State, Disabled>(host: UpdateCheckHost<State, Disabled>): UpdateChecks<State> {
  const later = host.setTimeout ?? ((run, ms) => setTimeout(run, ms))
  const every = host.setInterval ?? ((run, ms) => setInterval(run, ms))
  async function check(): Promise<State> {
    const policy = host.policy()
    if (!policy.enabled) return host.blocked(policy)
    try {
      await host.query()
      return host.current()
    } catch (err) {
      host.warn('[updater] check failed:', err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return {
    check,
    startAutomatic() {
      if (!host.policy().enabled || !host.automatic) return
      // check already warns; automatic checks have no caller to reject to.
      later(() => { void check().catch(() => undefined) }, AUTO_UPDATE_INITIAL_DELAY_MS)
      every(() => { void check().catch(() => undefined) }, AUTO_UPDATE_INTERVAL_MS)
    },
  }
}
