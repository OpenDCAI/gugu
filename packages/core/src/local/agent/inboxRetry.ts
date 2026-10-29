import { coreLogger } from '../../log'

const log = coreLogger('agent-inbox-reader')
type Retry = { attempts: number; timer?: ReturnType<typeof setTimeout> }
const retries = new Map<string, Retry>()

/** A new real trigger supersedes the timer, but consecutive failures retain their backoff. */
export function beginInboxAttempt(agentUserId: string): void {
  const retry = retries.get(agentUserId)
  if (retry?.timer) clearTimeout(retry.timer)
}

export function clearInboxRetry(agentUserId: string): void {
  beginInboxAttempt(agentUserId)
  retries.delete(agentUserId)
}

/** Only rejected pulls enter here. Normal admission deferrals and settled turns never poll. */
export function retryInboxFailure(agentUserId: string, error: unknown, pull: () => void): void {
  const retry = retries.get(agentUserId) ?? { attempts: 0 }
  if (retry.timer) clearTimeout(retry.timer)
  retry.attempts += 1
  const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(retry.attempts - 1, 6))
  retry.timer = setTimeout(() => {
    if (retries.get(agentUserId) !== retry) return
    retry.timer = undefined
    pull()
  }, delayMs)
  retry.timer.unref?.()
  retries.set(agentUserId, retry)
  log.warn({ agentUserId, attempt: retry.attempts, delayMs, err: error instanceof Error ? error.message : String(error) },
    'agent inbox pull retry scheduled; unread rows will be pulled without another message')
}

export function resetInboxRetries(): void {
  for (const agentUserId of retries.keys()) clearInboxRetry(agentUserId)
}
