import { afterEach, expect, it, vi } from 'vitest'
import { waitForAssistantControl } from '../../apps/desktop/src/lib/assistantControlReady'

afterEach(() => vi.useRealTimers())
it('waits for a real read-only RPC acknowledgement, independently of awake/presence', async () => {
  vi.useFakeTimers()
  const check = vi.fn().mockRejectedValueOnce(new Error('CHANNEL_ERROR')).mockResolvedValue({})
  const action = vi.fn()
  const run = waitForAssistantControl(check, () => {}).then(action)
  await vi.advanceTimersByTimeAsync(100)
  expect(action).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  await run
  expect(check).toHaveBeenCalledTimes(2)
  expect(action).toHaveBeenCalledOnce()
})
it('bounds silent RPC reads and refuses account changes before starting an authorization', async () => {
  vi.useFakeTimers()
  const check = vi.fn(() => new Promise<void>(() => {}))
  const waiting = expect(waitForAssistantControl(check, () => {}, 1_000)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(1_001)
  await waiting
  expect(check).toHaveBeenCalledOnce()
  const changed = () => { throw new Error('Account changed') }
  await expect(waitForAssistantControl(check, changed)).rejects.toThrow('Account changed')
  expect(check).toHaveBeenCalledOnce()
})
