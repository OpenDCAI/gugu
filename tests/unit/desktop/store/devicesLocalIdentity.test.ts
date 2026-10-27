// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { DevicesProvider } from '../../../../apps/desktop/src/store/devices'
import { useDevicesStore } from '../../../../apps/desktop/src/store/devicesContext'
import { writeCachedDevices } from '../../../../apps/desktop/src/store/devicesCache'
import { LocalDeviceUnidentifiedError } from '../../../../apps/desktop/src/lib/localDeviceIdentity'
import { createNode, createReactHarness } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  identified: null as null | (() => void),
}))

vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'account-a' } }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { listDevices: mocks.listDevices } }))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: async () => [] }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ subscribeAccountRevision: () => () => undefined }),
}))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return {
    ...original,
    platform: new Proxy(original.platform, {
      get(target, key, receiver) {
        if (key === 'subscribeLocalDeviceIdentified') {
          return (listener: () => void) => { mocks.identified = listener; return () => { mocks.identified = null } }
        }
        return Reflect.get(target, key, receiver)
      },
    }),
  }
})

function device(id: string, extra: Partial<Device> = {}): Device {
  return {
    device_id: id, label: id, hostname: id, platform: 'darwin', status: 'online', last_seen_at: '2026-10-27T00:00:00Z',
    capabilities: { runtimes: [] } as unknown as Device['capabilities'], machine_id: null, is_online: true, ...extra,
  } as Device
}

let seen: Device[] = []
function Probe() {
  seen = useDevicesStore().devices
  return null
}

/**
 * Beta 1040: on every start the first device read ran before the local host had the sign-in, came back with this
 * computer's row unmarked, and the session page took that row for another, offline computer — whose "projects" were
 * this computer's, dropped from the sidebar once it was recognized. Until it is identified, the list keeps the one it
 * had (its own row marked), and it is read again the moment the local host identifies it.
 */
describe('DevicesProvider before this computer is identified', () => {
  let harness: ReturnType<typeof createReactHarness>
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    localStorage.clear()
    seen = []
    mocks.identified = null
    harness = createReactHarness()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    harness.cleanup()
    consoleError.mockRestore()
  })

  it('keeps the cached list with its own row marked, reports no failure, and reads again once identified', async () => {
    writeCachedDevices('account-a', [device('this-mac', { is_current_device: true }), device('d22', { is_current_device: false })])
    mocks.listDevices.mockReset().mockRejectedValueOnce(new LocalDeviceUnidentifiedError())

    await harness.render(createNode(DevicesProvider, {}, createNode(Probe)))
    await act(async () => { await Promise.resolve() })

    expect(mocks.listDevices).toHaveBeenCalledTimes(1)
    expect(seen.find((row) => row.device_id === 'this-mac')?.is_current_device).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()
    if (!mocks.identified) throw new Error('the provider does not listen for the identification')

    mocks.listDevices.mockResolvedValueOnce([
      device('this-mac', { is_current_device: true, label: 'renamed-mac' }),
      device('d22', { is_current_device: false }),
    ])
    await act(async () => { mocks.identified?.(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(mocks.listDevices).toHaveBeenCalledTimes(2)
    expect(seen.find((row) => row.device_id === 'this-mac')).toMatchObject({ is_current_device: true, label: 'renamed-mac' })
  })
})
