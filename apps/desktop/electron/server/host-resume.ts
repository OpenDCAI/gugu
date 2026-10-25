/** A retained process needs a cause-driven reconnect after the host resumes.
 * Inbox reconciliation is independent of realtime/auth recovery: a dead socket
 * must never hold the first unread pull behind its heartbeat timeout. */
export function createHostResumeHandler(deps: {
  pullUnread: () => Promise<void>
  reconnect: () => Promise<void>
  reconcile: () => Promise<void>
  notifyCommands: () => void
  observed: (source: string) => void
  failed: (operation: string, error: unknown) => void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let lastObserved = -Infinity
  return (source: string): void => {
    const at = now()
    // The controller and the first post-suspend timer can observe the same wake.
    if (at - lastObserved >= 0 && at - lastObserved < 1_000) return
    lastObserved = at
    deps.observed(source)
    for (const [operation, run] of [
      ['inbox', deps.pullUnread],
      ['realtime', deps.reconnect],
      ['credentials', deps.reconcile],
      ['commands', deps.notifyCommands],
    ] as const) {
      try {
        void Promise.resolve(run()).catch(error => deps.failed(operation, error))
      } catch (error) {
        deps.failed(operation, error)
      }
    }
  }
}

/** Fallback for hosts without a native power event or controller notification. */
export function watchHostResumeGap(resume: (source: string) => void, now = Date.now): () => void {
  let previous = now()
  const timer = setInterval(() => {
    const current = now()
    const gap = current - previous
    previous = current
    if (gap >= 10_000) resume('wall-clock-gap')
  }, 1_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** OS power events attest whole-device sleep; foreground and wall-clock gaps do not. */
export function installNativeSleepActivity(
  power: { on(event: 'suspend', callback: () => void): unknown; on(event: 'resume', callback: () => void): unknown },
  record: (sleep: { since: number; until: number; source: 'native-power' }) => void,
  now = Date.now,
): void {
  let since: number | null = null
  power.on('suspend', () => { since ??= now() })
  power.on('resume', () => {
    const until = now(), start = since; since = null
    if (start !== null && start < until) record({ since: start, until, source: 'native-power' })
  })
}
