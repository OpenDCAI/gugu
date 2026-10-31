import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  owner: 'owner', devices: [{ device_id: 'here', is_current_device: true }, { device_id: 'other', is_current_device: false }],
  known: true, variants: vi.fn(), select: vi.fn(), navigate: vi.fn(), reveal: vi.fn(), rpcOn: vi.fn(),
}))
vi.mock('@/store/devicesCache', () => ({ cachedDevicesAccount: () => state.owner, readCachedDevices: () => state.devices }))
vi.mock('@/hooks/useSessionpageReveal', () => ({ revealSessionpage: state.reveal }))
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: state.rpcOn }))
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: state.navigate } } }))
vi.mock('@renderer/features/remote-hosts/device-scope-store', () => ({ LOCAL_DEVICE_SCOPE: 'local', libraryDeviceStore: { select: state.select } }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => state.known ? {} : null } }))
const { openAppDetailLink } = await import('../../../../apps/desktop/src/session/renderer/features/apps/app-detail-link')
const target = { kind: 'app-detail' as const, extensionId: 'kanban', deviceId: 'other', variant: 'mine' }
beforeEach(() => {
  vi.clearAllMocks(); state.owner = 'owner'; state.known = true
  state.variants.mockResolvedValue({ success: true, data: { variants: [{ name: 'mine' }] } })
  state.rpcOn.mockReturnValue({ extensions: { variants: state.variants } })
})
it('opens the named device detail without switching its variant', async () => {
  await openAppDetailLink(target, 'owner')
  expect(state.rpcOn).toHaveBeenCalledWith('other')
  expect(state.variants).toHaveBeenCalledWith('kanban')
  expect(state.select).toHaveBeenCalledWith('other')
  expect(state.navigate).toHaveBeenCalledWith('apps', { detail: target })
})
it('uses local RPC only when the registered target really is this device', async () => {
  await openAppDetailLink({ ...target, deviceId: 'here' }, 'owner')
  expect(state.rpcOn).toHaveBeenCalledWith(null)
  expect(state.select).toHaveBeenCalledWith('local')
})
it.each(['unknown', 'foreign-account', 'unavailable', 'missing-variant'])('refuses %s without selecting a local namesake', async (caseName) => {
  if (caseName === 'foreign-account') state.owner = 'other-account'
  if (caseName === 'unavailable') state.known = false
  if (caseName === 'missing-variant') state.variants.mockResolvedValue({ success: true, data: { variants: [] } })
  await expect(openAppDetailLink({ ...target, ...(caseName === 'unknown' ? { deviceId: 'missing' } : {}) }, 'owner')).rejects.toThrow()
  expect(state.select).not.toHaveBeenCalled(); expect(state.navigate).not.toHaveBeenCalled()
})
it('does not navigate after the caller changes while the device answers', async () => {
  await openAppDetailLink(target, 'owner', () => false)
  expect(state.select).not.toHaveBeenCalled()
})

it('opens the named device market detail even when that App is not installed (L11)', async () => {
  state.variants.mockResolvedValue({ success: false, error: 'App kanban is not installed' })
  await openAppDetailLink({ kind: 'app-detail', extensionId: 'kanban', deviceId: 'other' }, 'owner')
  expect(state.select).toHaveBeenCalledWith('other'); expect(state.navigate).toHaveBeenCalled()
})
