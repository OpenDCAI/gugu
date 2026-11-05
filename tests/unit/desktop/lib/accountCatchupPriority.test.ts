import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccountCatchupPriority, FOREGROUND_PRIORITY_BUDGET_MS } from '../../../../apps/desktop/src/lib/accountCatchupPriority'

afterEach(() => vi.useRealTimers())

describe('account catch-up priority', () => {
  it('bounds foreground priority when a view never settles, and releases each lease once', async () => {
    vi.useFakeTimers()
    const priority = createAccountCatchupPriority()
    const finish = priority.begin()
    let ready = false
    const next = priority.scheduling.beforeApply(new AbortController().signal).then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(FOREGROUND_PRIORITY_BUDGET_MS - 1)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await next
    expect(ready).toBe(true)
    finish(); finish()
    const second = priority.begin()
    ready = false
    const waiting = priority.scheduling.beforeApply(new AbortController().signal).then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)
    second()
    await waiting
    expect(ready).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a waiting account without resuming it when another read finishes', async () => {
    const priority = createAccountCatchupPriority()
    const finish = priority.begin()
    const account = new AbortController()
    const waiting = priority.scheduling.beforeApply(account.signal)
    account.abort(new Error('account changed'))
    await expect(waiting).rejects.toThrow('account changed')
    finish()
    await priority.scheduling.beforeApply(new AbortController().signal)
  })
})
