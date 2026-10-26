// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const network = vi.hoisted(() => ({ rpc: vi.fn(), sleeping: true }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: network.rpc }))
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: () => ({ snapshot: { deviceId: 'cloud', state: network.sleeping ? 'asleep' : 'awake' } }) }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }))
vi.mock('@/platform', () => ({ platform: { capabilities: { sessionHost: false } } }))
afterEach(() => vi.clearAllMocks())
it('background cloud-browser status and screenshots do not attach to the sleeping host', async () => {
  network.rpc.mockResolvedValue({ result: { value: { success: true, data: {} } } })
  const { fetchCloudBrowserStatus, fetchCloudBrowserSnapshot } = await import('@/lib/cloudBrowser')
  await expect(fetchCloudBrowserStatus('cloud')).rejects.toMatchObject({ code: 'unreachable' })
  await expect(fetchCloudBrowserSnapshot('cloud', null, 500)).rejects.toMatchObject({ code: 'unreachable' })
  expect(network.rpc).not.toHaveBeenCalled()
  network.sleeping = false
  await expect(fetchCloudBrowserStatus('cloud')).resolves.toEqual({})
  expect(network.rpc).toHaveBeenCalledTimes(1)
})
