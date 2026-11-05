import { describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import type { DeviceActionGrants, DeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { createComputerFamily } from '../../../../apps/desktop/electron/device-actions/families/computer'
import { createScreenFamily } from '../../../../apps/desktop/electron/device-actions/families/screen'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

function setup(platform: NodeJS.Platform = 'darwin') {
  const grants: DeviceActionGrants = { groups: { screen: true }, connectedAt: {}, deniedActions: [], denyAll: false }
  const store: DeviceActionGrantsStore = {
    read: () => grants, setGroup: vi.fn(() => grants), setActionEnabled: vi.fn(() => grants),
    setDenyAll: vi.fn(() => grants), resetActionOverrides: vi.fn(() => grants),
    record: vi.fn(), recent: () => [], onChange: () => () => undefined,
  }
  const captureScreen = vi.fn(async (_options: { maxEdge: number }) => ({ mimeType: 'image/jpeg', data: 'actual-capture', width: 1200, height: 800, displays: 2 }))
  const cua = vi.fn(() => { throw new Error('Screen capture must not start or inspect CUA') })
  const helperCall = vi.fn(async (_method: string, _params?: unknown) => ({ status: 'granted' }))
  const deps: FamilyDeps = {
    platform, nativeDir: null, now: () => new Date(), homedir: () => '/unused',
    clipboardRead: () => '', clipboardWrite: vi.fn(), notify: vi.fn(async () => ({ shown: true })),
    openExternal: vi.fn(), trashItem: vi.fn(), jxa: vi.fn(), exec: vi.fn(),
    macHelper: () => ({ available: () => ({ ok: true as const }), call: helperCall as never, dispose: vi.fn() }),
    captureScreen, cua,
  }
  const provider = createDeviceActionsProvider({ store, deps,
    families: [createComputerFamily(null), createScreenFamily(platform)],
    managedBy: group => group === 'computer' ? { on: false, offMessage: 'Computer Use is off' } : null })
  const invoke = async () => {
    const permit = await provider.provider.permit('screen.get')
    return permit.ok ? provider.provider.run('screen.get', {}, { callId: 'screen-test', signal: new AbortController().signal, note: () => undefined }) : permit
  }
  return { provider, invoke, grants, store, captureScreen, cua, helperCall, deps }
}

describe('generic screen actions', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('%s captures a picture with Computer Use off and no CUA binary', async platform => {
    const { invoke, provider, captureScreen, cua } = setup(platform)
    expect(await invoke()).toEqual({ ok: true, data: { width: 1200, height: 800, displays: 2,
      pictures: [{ label: 'screen.get screenshot', mimeType: 'image/jpeg', data: 'actual-capture' }] } })
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 1568 })
    expect(cua).not.toHaveBeenCalled()
    if (platform !== 'linux') expect(await provider.provider.permit('computer.click')).toMatchObject({ ok: false, code: 'not_granted' })
  })

  it('still requires the screen grant, including when Computer Use is installed', async () => {
    const { invoke, grants, captureScreen } = setup()
    grants.groups = {}
    expect(await invoke()).toMatchObject({ ok: false, code: 'not_granted' })
    expect(captureScreen).not.toHaveBeenCalled()
  })

  it.each(['deny-all', 'action-disabled'] as const)('honors %s before capture', async restriction => {
    const { invoke, grants, captureScreen } = setup()
    if (restriction === 'deny-all') grants.denyAll = true
    else grants.deniedActions = ['screen.get']
    expect(await invoke()).toMatchObject({ ok: false, code: 'not_granted' })
    expect(captureScreen).not.toHaveBeenCalled()
  })

  it('the macOS Connect action requests only Screen Recording and probes Electron, not CUA or AX', async () => {
    const { provider, helperCall, captureScreen, cua } = setup()
    expect(await provider.connect('screen')).toEqual({ ok: true })
    expect(helperCall).toHaveBeenCalledWith('permissions.request', { kind: 'screen' }, expect.anything())
    expect(helperCall).toHaveBeenCalledTimes(1)
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 320 })
    expect(cua).not.toHaveBeenCalled()
  })

  it('does not mark the screen connected or capture when the person denies Screen Recording', async () => {
    const { provider, helperCall, captureScreen, store } = setup()
    helperCall.mockResolvedValue({ status: 'denied' })
    expect(await provider.connect('screen')).toMatchObject({ ok: false, code: 'os_permission', restart: true, settingsUrl: expect.stringContaining('Privacy_ScreenCapture') })
    expect(captureScreen).not.toHaveBeenCalled()
    expect(store.setGroup).not.toHaveBeenCalled()
  })

  it('checks the real Electron capture even if the helper reports permission granted', async () => {
    const { provider, captureScreen, store } = setup()
    captureScreen.mockRejectedValue(new NativeCallError('os_permission', 'Electron lacks Screen Recording'))
    expect(await provider.connect('screen')).toMatchObject({ ok: false, code: 'os_permission', restart: true, settingsUrl: expect.stringContaining('Privacy_ScreenCapture') })
    expect(store.setGroup).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)('%s probes native capture without a Mac permission helper', async platform => {
    const { provider, captureScreen, helperCall, cua } = setup(platform)
    expect(await provider.connect('screen')).toEqual({ ok: true })
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 320 })
    expect(helperCall).not.toHaveBeenCalled()
    expect(cua).not.toHaveBeenCalled()
  })

  it('reports an unavailable native capture rather than invoking a CUA fallback', async () => {
    const { provider, invoke, deps, cua } = setup()
    delete deps.captureScreen
    expect(await invoke()).toMatchObject({ ok: false, code: 'unsupported' })
    // Connect maps non-permission probe failures to execution_failed; action discovery is unsupported.
    expect(await provider.connect('screen')).toMatchObject({ ok: false, code: 'execution_failed' })
    expect(cua).not.toHaveBeenCalled()
  })

  it('marks the remaining AX lookup unavailable without disabling generic capture', async () => {
    const { invoke, provider, deps } = setup()
    const cua = vi.fn(() => ({ available: () => ({ ok: false as const, message: 'CUA absent' }), callTool: vi.fn(), stop: vi.fn(), dispose: vi.fn() }))
    deps.cua = cua
    expect(await provider.provider.permit('screen.elements.find')).toMatchObject({ ok: false, code: 'unsupported', message: 'CUA absent' })
    expect(cua).toHaveBeenCalledTimes(1)
    expect(await invoke()).toMatchObject({ ok: true })
    expect(cua).toHaveBeenCalledTimes(1)
  })

  it('propagates an actual capture failure without fabricating an image', async () => {
    const { invoke, captureScreen } = setup()
    captureScreen.mockRejectedValue(new NativeCallError('execution_failed', 'No screen source'))
    expect(await invoke()).toEqual({ ok: false, code: 'execution_failed', message: 'No screen source' })
  })
})
