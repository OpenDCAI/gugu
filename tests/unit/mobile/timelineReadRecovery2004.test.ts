import { afterEach, expect, it, vi } from 'vitest'
import { recoverTimelineRead } from '../../../apps/desktop/src/mobile/agent-watch/timeline-read-recovery'

afterEach(() => { vi.useRealTimers() })

it('retries transient reads with bounded backoff and returns the recovered data', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ cursor: 'recovered' })
  const result = recoverTimelineRead(read, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(599)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toEqual({ cursor: 'recovered' })
  expect(read).toHaveBeenCalledTimes(2)
})

it('exhausts background retries before exposing the original failure', async () => {
  vi.useFakeTimers()
  const cause = new Error('still unavailable')
  const read = vi.fn().mockRejectedValue(cause)
  let failed: unknown
  const result = recoverTimelineRead(read, new AbortController().signal).catch(error => { failed = error })
  await vi.advanceTimersByTimeAsync(5099)
  expect(failed).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  await result
  expect(failed).toBe(cause)
  expect(read).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).toHaveBeenCalledTimes(4)
})

it('cancels a queued retry when the page or record generation changes', async () => {
  vi.useFakeTimers()
  const owner = new AbortController()
  const read = vi.fn().mockRejectedValue(new Error('offline'))
  const failed = recoverTimelineRead(read, owner.signal).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  owner.abort()
  expect(await failed).toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
