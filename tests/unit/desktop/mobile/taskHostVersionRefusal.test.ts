// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'

const network = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), warn: vi.fn(), usable: false, restart: () => undefined as void }))
vi.mock('@/lib/remoteSessionHost', () => ({ openPhoneSessionHostPipe: () => Object.assign(network.open, {
  watchPeerRestart: (cb: () => void) => { network.restart = cb; return () => undefined },
}) }))
vi.mock('@/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: () => ({ snapshot: null }), subscribeCloudComputerState: () => () => undefined }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn: network.warn, error() {} }) }))

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it.each(['advertised-version', 'new-version-after-unknown', 'host-ready-without-version'])('pauses foreground retries and automatically recovers on %s', async signal => {
  vi.useFakeTimers()
  network.usable = false
  network.open.mockClear()
  network.warn.mockClear()
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
  const id = 'version-peer-' + signal
  const device = (version: string | null, online = true) => ({ device_id: id, is_online: online, label: 'fixture', capabilities: version ? { app_version: version } : {} }) as Device
  const writeCurrent = (version: string | null, online = true) => writeCachedDevices('owner', [
    ...['advertised-version', 'new-version-after-unknown', 'host-ready-without-version']
      .filter(other => other !== signal)
      .map(other => ({ device_id: 'version-peer-' + other, is_online: false, label: 'fixture', capabilities: {} }) as Device),
    device(version, online),
  ])
  const previousVersion = signal === 'advertised-version' ? 'old' : null
  try {
    writeCurrent(previousVersion)
    await expect(fetchCreateOptions(id)).rejects.toMatchObject({ code: 'server_outdated' })
    for (let beat = 0; beat < 10; beat += 1) {
      writeCurrent(previousVersion)
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(network.open).toHaveBeenCalledTimes(1)
    expect(network.warn).toHaveBeenCalledTimes(1)
    network.usable = true
    if (signal !== 'host-ready-without-version') writeCurrent('new')
    else network.restart()
    await flush()
    expect(network.open).toHaveBeenCalledTimes(2)
    await expect(fetchCreateOptions(id)).resolves.toEqual({})
  } finally {
    writeCurrent('new', false)
    await flush()
  }
})
