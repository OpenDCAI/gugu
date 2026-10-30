// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'

const network = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), warn: vi.fn(), usable: false }))
vi.mock('@/lib/remoteSessionHost', () => ({ openPhoneSessionHostPipe: () => network.open }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: () => ({ snapshot: null }), subscribeCloudComputerState: () => () => undefined }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn: network.warn, error() {} }) }))

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('does not turn foreground/network events into protocol retries, and reconnects after a new advertised host version', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  network.open.mockImplementation(async (handlers: { onFrame(frame: string): void }) => {
    if (!network.usable) throw Object.assign(new Error('update remote host'), { code: 'server_outdated' })
    return {
      send(frame: string) {
        const request = JSON.parse(frame)
        if (request.t === 'invoke') handlers.onFrame(JSON.stringify({ t: 'result', id: request.id, ok: true, value: { ok: true, value: {} } }))
      },
      close: network.close,
    }
  })
  const { writeCachedDevices } = await import('@/store/devicesCache')
  const { fetchCreateOptions } = await import('@/mobile/agent-watch/sessionpage-rpc')
  const device = (version: string, online = true) => ({ device_id: 'version-peer', is_online: online, label: 'fixture', capabilities: { app_version: version } }) as Device
  try {
    writeCachedDevices('owner', [device('old')])
    await expect(fetchCreateOptions('version-peer')).rejects.toMatchObject({ code: 'server_outdated' })
    for (let beat = 0; beat < 10; beat += 1) {
      writeCachedDevices('owner', [device('old')])
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(network.open).toHaveBeenCalledTimes(1)
    expect(network.warn).toHaveBeenCalledTimes(1)
    network.usable = true
    writeCachedDevices('owner', [device('new')])
    await flush()
    await expect(fetchCreateOptions('version-peer')).resolves.toEqual({})
    expect(network.open).toHaveBeenCalledTimes(2)
  } finally {
    writeCachedDevices('owner', [device('new', false)])
    await flush()
  }
})
