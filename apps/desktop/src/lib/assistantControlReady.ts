import { isAssistantActionRefusal } from './assistantActionRefusal'

export const ASSISTANT_CONTROL_READY_TIMEOUT_MS = 60_000

/** Only explicit operations use this bounded read-only handshake. It never wakes a host. */
export async function waitForAssistantControl(
  check: () => Promise<unknown>,
  assertCurrent: () => void | Promise<void>,
  budgetMs = ASSISTANT_CONTROL_READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  let delay = 250
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    await assertCurrent()
    signal?.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Assistant control channel readiness timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => rejectAbort?.(signal!.reason)
    let rejectAbort: ((reason: unknown) => void) | undefined
    try {
      // A silent read owns the remainder of this budget: do not overlap another
      // read or retry a non-idempotent authorization while its outcome is unknown.
      await Promise.race([check(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Assistant control channel readiness timed out')), remaining)
      }), new Promise<never>((_, reject) => {
        rejectAbort = reject
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })])
      signal?.throwIfAborted()
      await assertCurrent()
      return
    } catch (error) {
      signal?.throwIfAborted()
      await assertCurrent()
      if (isAssistantActionRefusal(error)) throw error
      if (Date.now() >= deadline) throw error
      const code = (error as { code?: string } | null)?.code
      if (code === 'unknown_method' || code === 'forbidden' || code === 'unauthorized') throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))))
    delay = Math.min(delay * 2, 2_000)
  }
  throw new Error('Assistant control channel readiness timed out')
}
