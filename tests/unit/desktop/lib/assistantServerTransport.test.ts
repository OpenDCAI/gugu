// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ desktop: true, desktopPipe: vi.fn(), phonePipe: vi.fn() }))
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => f.desktop ? { invoke: vi.fn(), eventOn: vi.fn() } : null }))
vi.mock('@/lib/remoteSessionHost', () => ({ openMachineSessionHostPipe: f.desktopPipe, openPhoneSessionHostPipe: f.phonePipe }))
vi.mock('@/session/shared/lib/ipc/session-host-client', () => ({
  createSessionHostClient: () => ({ api: { invoke: vi.fn(async () => null) }, state: () => 'open' }),
  SESSION_HOST_CLIENT_HEARTBEAT_MS: 20_000,
}))
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => [], subscribeCachedDevices: vi.fn() }))
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: () => ({ snapshot: null }), subscribeCloudComputerState: vi.fn() }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpcOn: vi.fn() }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }))
import { machineRpc } from '@/mobile/agent-watch/sessionpage-rpc'

it('opens the real desktop pipe with its desktop hello for server assistant RPC', async () => {
  f.desktop = true
  await machineRpc('desktop-test-server').assistantHome.start({} as never)
  expect(f.desktopPipe).toHaveBeenCalledWith('desktop-test-server')
  expect(f.phonePipe).not.toHaveBeenCalled()
})
it('keeps a phone on the phone pipe without acquiring a desktop hello', async () => {
  f.desktop = false
  await machineRpc('phone-test-server').sessions.getSessions()
  expect(f.phonePipe).toHaveBeenCalledWith('phone-test-server')
})
