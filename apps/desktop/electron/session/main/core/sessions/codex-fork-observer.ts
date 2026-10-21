type ObservedCodexFork = {
  parentThreadId: string
  state: 'pending' | 'adopted'
}

// The app-server event and the five-second rollout scan are separate clocks. Keep their
// handoff in memory so a fork being classified as a TUI rewind cannot become a sidebar row
// while its provider session id is being persisted.
const observedForks = new Map<string, ObservedCodexFork>()

export function observeCodexFork(threadId: string, parentThreadId: string): void {
  if (!threadId || !parentThreadId || threadId === parentThreadId) return
  observedForks.set(threadId, { parentThreadId, state: 'pending' })
}

export function settleCodexForkObservation(threadId: string, adopted: boolean): void {
  const observed = observedForks.get(threadId)
  if (!observed) return
  if (adopted) {
    observed.state = 'adopted'
    return
  }
  observedForks.delete(threadId)
}

/** True while this child is either awaiting classification or already owned by its parent row. */
export function isObservedCodexFork(threadId: string): boolean {
  return observedForks.has(threadId)
}
