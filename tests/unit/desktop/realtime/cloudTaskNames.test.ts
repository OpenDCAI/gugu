import { describe, expect, test, vi } from 'vitest'
import { createCloudTaskNameAdopter } from '../../../../apps/desktop/electron/sessionpage/cloud-task-names'

describe('cloud task name adoption', () => {
  test('coalesces a burst and adopts the current owner in its trailing pass', async () => {
    let owner = 'owner-a'
    const seen: string[] = []
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const adopt = vi.fn(async () => {
      seen.push(owner)
      if (seen.length === 1) await blocked
    })
    const failed = vi.fn()
    const refresh = createCloudTaskNameAdopter({ adopt, failed })
    const first = refresh()
    owner = 'owner-b'
    const pending = Array.from({ length: 10 }, () => refresh())
    expect(adopt).toHaveBeenCalledOnce()
    expect(pending.every(promise => promise === first)).toBe(true)
    release()
    await first
    expect(seen).toEqual(['owner-a', 'owner-b'])
    expect(failed).not.toHaveBeenCalled()
    await refresh()
    expect(seen).toEqual(['owner-a', 'owner-b', 'owner-b'])
  })

  test('logs a failed adoption and still processes the queued change', async () => {
    let reject!: (error: Error) => void
    const blocked = new Promise<void>((_resolve, fail) => { reject = fail })
    const adopt = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue(undefined)
    const failed = vi.fn()
    const refresh = createCloudTaskNameAdopter({ adopt, failed })
    const first = refresh()
    refresh()
    const error = new Error('cloud unavailable')
    reject(error)
    await first
    expect(failed).toHaveBeenCalledWith(error)
    expect(adopt).toHaveBeenCalledTimes(2)
    await refresh()
    expect(adopt).toHaveBeenCalledTimes(3)
  })
})
