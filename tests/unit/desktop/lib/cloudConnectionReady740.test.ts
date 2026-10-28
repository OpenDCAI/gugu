import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'

const f = vi.hoisted(() => ({ state: vi.fn(), wake: vi.fn() }))
vi.mock('@/lib/cloudComputer', () => ({ rendererCloudComputerClient: () => f }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn() {}, debug() {}, info() {} }) }))
const { ensureCloudConnectionReady, refreshCloudComputer, resetCloudComputerState } = await import('@/lib/cloudComputerStore')
const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'cloud', since: null, error: null })

beforeEach(async () => {
  vi.clearAllMocks()
  resetCloudComputerState()
  f.state.mockResolvedValue(snap('awake'))
  await refreshCloudComputer()
})
afterEach(() => vi.useRealTimers())

it('re-reads the controller after attach failure and resumes despite stale awake presence', async () => {
  vi.useFakeTimers()
  f.state.mockResolvedValue(snap('asleep'))
  f.wake.mockImplementationOnce(async () => { f.state.mockResolvedValue(snap('awake')) })
  const online = vi.fn(async () => true)
  const resumed = ensureCloudConnectionReady('cloud', { isOnline: online })
  await vi.advanceTimersByTimeAsync(2_000)
  await resumed
  expect(f.wake).toHaveBeenCalledOnce()
  expect(online).toHaveBeenCalledWith('cloud')
})

it('does not wake unrelated machines or periodically wake an unused cloud computer', async () => {
  await ensureCloudConnectionReady('another-machine', { isOnline: async () => false })
  expect(f.state).toHaveBeenCalledOnce() // Initial refresh only.
  expect(f.wake).not.toHaveBeenCalled()
})

it('shares simultaneous connection checks and permits a later retry after completion', async () => {
  let answer!: (value: CloudComputerSnapshot) => void
  f.state.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const one = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  const two = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  expect(one).toBe(two)
  answer(snap('awake'))
  await one
  await ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  expect(f.state).toHaveBeenCalledTimes(3)
})

it('account changes abort the old check before any wake under the next account', async () => {
  let answer!: (value: CloudComputerSnapshot) => void
  f.state.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const old = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  resetCloudComputerState()
  answer(snap('asleep'))
  await expect(old).rejects.toThrow()
  expect(f.wake).not.toHaveBeenCalled()
})
