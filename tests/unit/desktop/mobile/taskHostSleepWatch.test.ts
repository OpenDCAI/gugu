// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'

const network = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), warn: vi.fn(), snapshot: { state: 'asleep', deviceId: 'cloud', error: null, since: null } as CloudComputerSnapshot }))
vi.mock('@/lib/remoteSessionHost', () => ({ openPhoneSessionHostPipe: () => network.open }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
vi.mock('@/lib/cloudComputer', () => ({ rendererCloudComputerClient: () => ({ state: async () => network.snapshot }) }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn: network.warn, error() {} }) }))

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

it('the real mobile session-host client never attaches during sleep and resumes from state/device events', async () => {
  vi.useFakeTimers()
  network.open.mockImplementation(async (handlers: { onFrame(frame: string): void }) => ({ send(frame: string) { const request = JSON.parse(frame); if (request.t === 'invoke') handlers.onFrame(JSON.stringify({ t: 'result', id: request.id, ok: true, value: { ok: true, value: {} } })) }, close: network.close }))
  const { writeCachedDevices } = await import('@/store/devicesCache')
  const { resetCloudComputerState, refreshCloudComputer } = await import('@/lib/cloudComputerStore')
  const { fetchCreateOptions, fetchSessionsList } = await import('@/mobile/agent-watch/sessionpage-rpc')
  writeCachedDevices('owner', [{ device_id: 'cloud', is_online: true, label: 'cloud' } as Device])
  resetCloudComputerState()
  await refreshCloudComputer()
  await expect(fetchCreateOptions('cloud')).rejects.toMatchObject({ code: 'unreachable' })
  await expect(fetchSessionsList('cloud')).rejects.toMatchObject({ code: 'unreachable' })
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(network.open).not.toHaveBeenCalled()
  network.snapshot = { ...network.snapshot, state: 'awake' }
  await refreshCloudComputer()
  await flush()
  expect(network.open).toHaveBeenCalledTimes(1)
  network.snapshot = { ...network.snapshot, state: 'asleep' }
  await refreshCloudComputer()
  await flush()
  expect(network.close).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(network.open).toHaveBeenCalledTimes(1)
  expect(network.warn).not.toHaveBeenCalled()
  network.snapshot = { ...network.snapshot, state: 'awake' }
  writeCachedDevices('owner', [{ device_id: 'cloud', is_online: false, label: 'cloud' } as Device])
  await refreshCloudComputer()
  await flush()
  expect(network.open).toHaveBeenCalledTimes(1)
  writeCachedDevices('owner', [{ device_id: 'cloud', is_online: true, label: 'cloud' } as Device])
  await flush()
  expect(network.open).toHaveBeenCalledTimes(2)
})
