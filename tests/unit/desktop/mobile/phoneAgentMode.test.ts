import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhoneAgentHostState } from '../../../../apps/desktop/src/mobile/local-agent/nativeAgent'

const test = vi.hoisted(() => ({
  ownerId: 'mode-owner', state: { ownerId: '', deviceId: '', status: 'ready', ready: true, sessions: [] } as PhoneAgentHostState,
  configure: vi.fn(), stopHost: vi.fn(), grants: vi.fn(), upsert: vi.fn(), rpcHost: vi.fn(), subscribe: vi.fn(),
  select: vi.fn(), readEq: vi.fn(), read: vi.fn(), update: vi.fn(), updateEq: vi.fn(), updated: vi.fn(), remove: vi.fn(),
  deviceInfo: vi.fn(), checkPermissions: vi.fn(),
}))
// Exercise the external store directly; no React tree is involved in lifecycle ordering.
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({
  phoneAgentAvailable: () => true,
  nativeAgent: { configure: test.configure, stopHost: test.stopHost, grants: test.grants, hostState: async () => test.state },
}))
vi.mock('../../../../apps/desktop/src/lib/phoneHostAuth', () => ({ withPhoneHostAuthHandoff: (work: () => Promise<unknown>) => work(), phoneHostSessionForHandoff: (session: unknown) => session }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: test.ownerId }, access_token: 'test-access', refresh_token: 'test-refresh', expires_at: 123 }), observeRendererSession: () => () => {} }))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://test.invalid', getSupabaseAnonKey: () => 'public-anon' }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  identityDb: { from: () => ({ upsert: test.upsert, select: test.select, update: test.update }) },
  dataClient: { channel: () => ({ on() { return this }, send: async () => 'ok' }) },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { removeDevice: test.remove } }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribeAuthenticatedRealtimeChannel: test.subscribe, unsubscribeAuthenticatedRealtimeChannel: async () => {} }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions', () => ({ nativePhoneActions: {
  deviceInfo: test.deviceInfo,
  checkPermissions: test.checkPermissions, specialStatus: async () => ({}), healthStatus: async () => ({}), setNotificationCollecting: async () => {},
} }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDataActions', () => ({ readPhoneDataStatus: async () => ({}) }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog', () => ({
  PHONE_ACTION_GROUPS: ['calendar', 'contacts', 'location', 'notifications', 'alarm', 'health', 'sms', 'recordings', 'photos'],
  buildPhoneActionsCapability: (_grants: unknown, os: { runtime: { calendar?: string } }) => ({ v: 1, updated_at: '2026-10-20T00:00:00Z', actions: [{ name: 'calendar.events.list', available: os.runtime.calendar === 'granted' }] }), capabilityFingerprint: JSON.stringify, phoneActionByName: () => undefined,
}))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneActionProvider', () => ({ createPhoneActionProvider: () => ({}), mergeCallRecord: () => [] }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRpcHost', () => ({ createPhoneDeviceRpcHost: test.rpcHost }))

import { disconnectPhoneDevice, startPhoneDevice, stopPhoneAgentHost, refreshPhoneDevice, PHONE_HEARTBEAT_MS, usePhoneDevice as readSnapshot } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceRuntime'
import { phoneDeviceId, phoneInstallId, setPhoneAgentHostEnabled, setPhoneDeviceEnabled } from '../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const start = (hostEnabled: boolean) => startPhoneDevice({ userId: test.ownerId, hostEnabled, noticeLabel: () => 'test', claimNotice: () => () => {} })
let stop: (() => void) | null = null
beforeEach(() => {
  vi.clearAllMocks()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
  phoneInstallId('owned-install', 'owned-registration')
  test.ownerId = crypto.randomUUID()
  test.state = { ownerId: test.ownerId, status: 'stopped', ready: false, sessions: [] }
  test.stopHost.mockResolvedValue(undefined)
  test.grants.mockResolvedValue(undefined)
  test.upsert.mockResolvedValue({ error: null })
  const readQuery = { eq: test.readEq, maybeSingle: test.read }
  test.readEq.mockReturnValue(readQuery)
  test.select.mockReturnValue(readQuery)
  test.read.mockResolvedValue({ data: { capabilities: { host_kind: 'phone', runtimes: ['pi'], host_runtime_capability: 1, keep: 'unchanged' } }, error: null })
  const updateQuery = { eq: test.updateEq, then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => test.updated().then(resolve, reject) }
  test.updateEq.mockReturnValue(updateQuery)
  test.update.mockReturnValue(updateQuery)
  test.updated.mockResolvedValue({ error: null })
  test.remove.mockResolvedValue(undefined)
  test.deviceInfo.mockResolvedValue({ manufacturer: 'Test', brand: 'Test', model: 'Phone', android: '15', sdk: 35, rom: null, device_name: null, app_version: 'test', package: 'app.gugu.chat.test', install_key: 'owned-install', registration_id: 'owned-registration' })
  test.checkPermissions.mockResolvedValue({ calendar: 'granted' })
  test.rpcHost.mockReturnValue({ beat: () => {}, dispose: () => {} })
  test.subscribe.mockImplementation((create) => create())
  test.configure.mockImplementation(async (config) => { test.state = { ...test.state, ownerId: config.ownerId, deviceId: config.deviceId }; return test.state })
})
afterEach(async () => {
  stop?.(); stop = null
  await stopPhoneAgentHost(test.ownerId)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('one phone endpoint owns registration and RPC', () => {
  it('does not register or subscribe the action-only endpoint until the native process actually exited', async () => {
    const exiting = deferred()
    test.stopHost.mockReturnValueOnce(exiting.promise)
    setPhoneDeviceEnabled(test.ownerId, true)
    stop = start(false)
    try {
      await vi.waitFor(() => expect(test.stopHost).toHaveBeenCalledOnce())
      expect(test.upsert).not.toHaveBeenCalled()
      expect(test.rpcHost).not.toHaveBeenCalled()
      expect(test.subscribe).not.toHaveBeenCalled()
      exiting.resolve()
      await vi.waitFor(() => expect(test.subscribe).toHaveBeenCalledOnce())
      expect(test.upsert).toHaveBeenCalledOnce()
      expect(test.configure).not.toHaveBeenCalled()
    } finally { exiting.resolve() }
  })

  it('keeps a same-owner host through a root remount, then drains it before switching to action-only mode', async () => {
    setPhoneDeviceEnabled(test.ownerId, true)
    setPhoneAgentHostEnabled(test.ownerId, true)
    stop = start(true)
    await vi.waitFor(() => expect(test.configure).toHaveBeenCalledOnce())
    stop()
    stop = start(true)
    await vi.waitFor(() => expect(test.configure).toHaveBeenCalledTimes(2))
    expect(test.stopHost).not.toHaveBeenCalled()
    expect(test.upsert).not.toHaveBeenCalled()
    expect(test.rpcHost).not.toHaveBeenCalled()
    const exiting = deferred()
    test.stopHost.mockReturnValueOnce(exiting.promise)
    setPhoneAgentHostEnabled(test.ownerId, false)
    stop()
    stop = start(false)
    try {
      await vi.waitFor(() => expect(test.stopHost).toHaveBeenCalledOnce())
      expect(test.upsert).not.toHaveBeenCalled()
      expect(test.subscribe).not.toHaveBeenCalled()
      exiting.resolve()
      await vi.waitFor(() => expect(test.subscribe).toHaveBeenCalledOnce())
      expect(test.upsert).toHaveBeenCalledOnce()
    } finally { exiting.resolve() }
  })

  it('keeps the real device row offline when a stopped native host has persisted Agents', async () => {
    const deviceId = phoneDeviceId(phoneInstallId('owned-install', 'owned-registration'), test.ownerId)
    test.state = { ownerId: test.ownerId, deviceId, ready: false, status: 'stopped', sessions: [{ sessionId: 'session-1', agentUserId: 'agent-1', displayName: 'Phone task', chatId: 'real-dm', status: 'idle', modelId: 'test-model' }] }
    await stopPhoneAgentHost(test.ownerId)
    expect(test.remove).not.toHaveBeenCalled()
    expect(test.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'offline', capabilities: { host_kind: 'phone', runtimes: [], host_runtime_capability: 0, keep: 'unchanged' } }))
    expect(test.readEq.mock.calls).toEqual([['user_id', test.ownerId], ['device_id', deviceId]])
    expect(test.updateEq.mock.calls).toEqual([['user_id', test.ownerId], ['device_id', deviceId]])
    await expect(disconnectPhoneDevice(test.ownerId)).resolves.toEqual({ removed: false, retainedForHost: true })
    expect(test.remove).not.toHaveBeenCalled()
  })

  it('still removes an action-only phone without task history', async () => {
    const deviceId = phoneDeviceId(phoneInstallId('owned-install', 'owned-registration'), test.ownerId)
    await expect(disconnectPhoneDevice(test.ownerId)).resolves.toEqual({ removed: true })
    expect(test.remove).toHaveBeenCalledWith(deviceId)
    expect(test.select).not.toHaveBeenCalled()
    expect(test.update).not.toHaveBeenCalled()
  })

  it('keeps a newer revoked permission reading when an older heartbeat finishes later', async () => {
    vi.useFakeTimers()
    setPhoneDeviceEnabled(test.ownerId, true)
    stop = start(false)
    await vi.waitFor(() => expect(test.upsert).toHaveBeenCalledOnce())
    const old = deferred<{ calendar: string }>()
    test.checkPermissions.mockReturnValueOnce(old.promise).mockResolvedValue({ calendar: 'denied' })
    vi.advanceTimersByTime(PHONE_HEARTBEAT_MS)
    const refreshed = refreshPhoneDevice()
    try {
      await vi.waitFor(() => expect(readSnapshot().os?.runtime.calendar).toBe('denied'))
      old.resolve({ calendar: 'granted' })
      await refreshed
      expect(readSnapshot().os?.runtime.calendar).toBe('denied')
      expect(test.upsert.mock.lastCall?.[0].capabilities.actions.actions[0].available).toBe(false)
    } finally { old.resolve({ calendar: 'granted' }); await refreshed }
  })

  it('orders concurrent settings reads while neither phone endpoint is running', async () => {
    const old = deferred<{ calendar: string }>()
    test.checkPermissions.mockReturnValueOnce(old.promise).mockResolvedValue({ calendar: 'denied' })
    const first = refreshPhoneDevice()
    try {
      await refreshPhoneDevice()
      expect(readSnapshot().os?.runtime.calendar).toBe('denied')
      old.resolve({ calendar: 'granted' })
      await first
      expect(readSnapshot().os?.runtime.calendar).toBe('denied')
    } finally { old.resolve({ calendar: 'granted' }); await first }
  })

  it('invalidates an off-page permission read when a new endpoint starts', async () => {
    const old = deferred<{ calendar: string }>()
    test.checkPermissions.mockReturnValueOnce(old.promise).mockResolvedValue({ calendar: 'denied' })
    const offRead = refreshPhoneDevice()
    setPhoneDeviceEnabled(test.ownerId, true)
    stop = start(false)
    try {
      await vi.waitFor(() => expect(test.upsert).toHaveBeenCalledOnce())
      const running = readSnapshot()
      old.resolve({ calendar: 'granted' })
      await offRead
      expect(readSnapshot()).toEqual(running)
      expect(readSnapshot().os?.runtime.calendar).toBe('denied')
    } finally { old.resolve({ calendar: 'granted' }); await offRead }
  })

  it('does not let a stopped boot publish OS, info or device identity after a new settings read', async () => {
    const old = deferred<{ calendar: string }>()
    test.checkPermissions.mockReturnValueOnce(old.promise).mockResolvedValue({ calendar: 'denied' })
    setPhoneDeviceEnabled(test.ownerId, true)
    stop = start(false)
    try {
      await vi.waitFor(() => expect(test.checkPermissions).toHaveBeenCalledOnce())
      stop()
      const stopped = readSnapshot()
      await refreshPhoneDevice()
      old.resolve({ calendar: 'granted' })
      await stopPhoneAgentHost(test.ownerId)
      expect(readSnapshot()).toMatchObject({ link: { state: 'off' }, os: { runtime: { calendar: 'denied' } }, deviceId: null, info: stopped.info })
      expect(test.upsert).not.toHaveBeenCalled()
      expect(test.subscribe).not.toHaveBeenCalled()
    } finally { old.resolve({ calendar: 'granted' }) }
  })

  it('stops before using a late deviceInfo response to bind or create the old endpoint', async () => {
    const old = deferred<Record<string, unknown>>()
    test.deviceInfo.mockReturnValueOnce(old.promise)
    setPhoneDeviceEnabled(test.ownerId, true)
    stop = start(false)
    try {
      await vi.waitFor(() => expect(test.deviceInfo).toHaveBeenCalledOnce())
      stop()
      const stopped = readSnapshot()
      old.resolve({ model: 'old phone', install_key: 'stale-install' })
      await stopPhoneAgentHost(test.ownerId)
      expect(readSnapshot()).toEqual(stopped)
      expect(test.rpcHost).not.toHaveBeenCalled()
      expect(test.checkPermissions).not.toHaveBeenCalled()
      expect(test.upsert).not.toHaveBeenCalled()
    } finally { old.resolve({ install_key: 'stale-install' }) }
  })

  it('lets a foreground refresh wait for boot without superseding or blocking initial registration', async () => {
    const boot = deferred<{ calendar: string }>()
    test.checkPermissions.mockReturnValueOnce(boot.promise)
    setPhoneDeviceEnabled(test.ownerId, true)
    stop = start(false)
    let refreshed: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(test.checkPermissions).toHaveBeenCalledOnce())
      refreshed = refreshPhoneDevice()
      await Promise.resolve()
      expect(test.checkPermissions).toHaveBeenCalledOnce()
      boot.resolve({ calendar: 'granted' })
      await refreshed
      expect(test.upsert).toHaveBeenCalledOnce()
      expect(test.subscribe).toHaveBeenCalledOnce()
      expect(readSnapshot().os?.runtime.calendar).toBe('granted')
    } finally { boot.resolve({ calendar: 'granted' }); await refreshed }
  })
})
