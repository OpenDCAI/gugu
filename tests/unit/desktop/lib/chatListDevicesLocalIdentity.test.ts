// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'

const mocks = vi.hoisted(() => ({
  self: vi.fn(),
  cloud: vi.fn(),
  platform: {} as Record<string, unknown>,
}))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc: vi.fn(), from: vi.fn() }, identityDb: { from: vi.fn(), rpc: vi.fn() },
  dataClient: { storage: { from: vi.fn() } }, syncSchemaClientSession: vi.fn(async () => {}),
  getCurrentAuthUserId: vi.fn(async () => 'account-a'),
}))
vi.mock('@gugu/core/cloud/devices', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listDevices: mocks.cloud,
}))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return {
    ...original,
    platform: new Proxy(original.platform, {
      get(target, key, receiver) {
        if (key in mocks.platform) return mocks.platform[key as string]
        if (key === 'getLocalDeviceSelfSnapshot') return undefined
        return Reflect.get(target, key, receiver)
      },
    }),
  }
})

const { chatService } = await import('../../../../apps/desktop/src/lib/chat')
const { LocalDeviceUnidentifiedError } = await import('../../../../apps/desktop/src/lib/localDeviceIdentity')

function row(id: string, status: Device['status'] = 'offline'): Device {
  return {
    device_id: id, label: id, hostname: id, platform: 'darwin', status, last_seen_at: '2026-10-27T00:00:00Z',
    capabilities: { runtimes: [] } as unknown as Device['capabilities'], machine_id: null, is_online: status === 'online',
  } as Device
}

beforeEach(() => {
  mocks.platform = {}
  mocks.self.mockReset()
  mocks.cloud.mockReset().mockResolvedValue([row('this-mac'), row('d22', 'online')])
})

// @@@local-device-truth on the list: the session page excludes this computer by its mark, so a list that cannot mark
// it must not be handed out where a local device exists.
describe('chatService.listDevices and this computer', () => {
  it('refuses to list where this computer runs a local device it cannot identify yet', async () => {
    mocks.platform.getLocalDeviceSelfSnapshot = mocks.self.mockResolvedValue(null)
    await expect(chatService.listDevices()).rejects.toBeInstanceOf(LocalDeviceUnidentifiedError)
  })

  it('marks its own row and every other row once it is identified', async () => {
    mocks.platform.getLocalDeviceSelfSnapshot = mocks.self.mockResolvedValue(row('this-mac', 'online'))
    const rows = await chatService.listDevices()
    expect(rows.map((device) => [device.device_id, device.is_current_device, device.is_online])).toEqual([
      ['this-mac', true, true],
      ['d22', false, true],
    ])
  })

  it('lists the cloud rows as they are where there is no local device (web, phone)', async () => {
    const rows = await chatService.listDevices()
    expect(rows.map((device) => device.device_id)).toEqual(['this-mac', 'd22'])
  })
})
