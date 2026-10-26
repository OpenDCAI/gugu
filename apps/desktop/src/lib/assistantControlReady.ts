/** Only explicit operations use this bounded read-only handshake. It never wakes a host. */
export async function waitForAssistantControl(
  check: () => Promise<unknown>,
  assertCurrent: () => void | Promise<void>,
  budgetMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  let delay = 250
  while (Date.now() < deadline) {
    await assertCurrent()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Assistant control channel readiness timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // A silent read owns the remainder of this budget: do not overlap another
      // read or retry a non-idempotent authorization while its outcome is unknown.
      await Promise.race([check(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Assistant control channel readiness timed out')), remaining)
      })])
      await assertCurrent()
      return
    } catch (error) {
      await assertCurrent()
      if (error instanceof TypeError) throw error
      if (Date.now() >= deadline) throw error
      const code = (error as { code?: string } | null)?.code
      if (code === 'unknown_method' || code === 'forbidden' || code === 'unauthorized') throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))))
    delay = Math.min(delay * 2, 2_000)
  }
  throw new Error('Assistant control channel readiness timed out')
}
