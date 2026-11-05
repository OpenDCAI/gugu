export const FOREGROUND_PRIORITY_BUDGET_MS = 5000

/** Foreground reads own the network/write budget before account-wide catch-up. */
export function createAccountCatchupPriority() {
  let readers = 0
  const waiting = new Set<() => void>()
  const begin = (): (() => void) => {
    readers += 1
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      readers -= 1
      if (readers === 0) for (const resume of [...waiting]) resume()
    }
    // A stalled view must not suspend durable account sync forever.
    const deadline = setTimeout(finish, FOREGROUND_PRIORITY_BUDGET_MS)
    return finish
  }
  const wait = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    while (readers > 0) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { waiting.delete(resume); signal.removeEventListener('abort', abort) }
        const resume = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(signal.reason) }
        waiting.add(resume)
        signal.addEventListener('abort', abort, { once: true })
      })
      signal.throwIfAborted()
    }
  }
  return {
    begin,
    scheduling: {
      // A task boundary lets a newly opened conversation/paint run between pages.
      async beforeRequest(signal: AbortSignal) {
        await new Promise<void>((resolve) => setTimeout(resolve, 16))
        await wait(signal)
      },
      beforeApply: wait,
    },
  }
}
