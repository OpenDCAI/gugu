// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionsListResult } from '@gugu/session-core/session-record/contract'
import { readLocalPhoneSessions, startPhoneAgentDirectorySync, usePhoneAgentDirectory } from '../../../apps/desktop/src/mobile/local-agent/usePhoneAgentDirectory'
import { deviceSessionsOf, liveDeviceSessions, retainDeviceSessions, retryDeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { createNode, createReactHarness, deferred, device, renderWithAppProviders } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), fetch: vi.fn(), native: vi.fn(), available: false, deviceId: 'phone' }))
vi.mock('../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [] }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchPhoneSessions: mocks.fetch }))
vi.mock('../../../apps/desktop/src/session/shared/remote-sessions/session-list-cache', () => ({ readCachedSessionList: mocks.read, writeCachedSessionList: mocks.write }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => 'owner' }))
vi.mock('../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({ phoneAgentAvailable: () => mocks.available, nativeAgent: { hostState: mocks.native } }))
vi.mock('../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings', () => ({ thisPhoneDeviceId: () => mocks.deviceId }))

const list = (): SessionpageSessionsListResult => ({
  projects: [{ id: 'phone-project', name: 'Phone', path: '/private/phone' }],
  sessions: [{ conversationId: 'phone-session', projectId: 'phone-project', title: 'Phone task', harness: 'pi', runtime: 'acp', agentStatus: 'working', lastInteractedAt: null, supported: false, recordState: 'harness-unsupported', chatId: 'real-dm', agent: { userId: 'agent-1' } }],
})
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
const stops: Array<() => void> = []
let harness: ReturnType<typeof createReactHarness> | undefined

beforeEach(() => {
  vi.useFakeTimers()
  mocks.read.mockReset().mockResolvedValue(null)
  mocks.write.mockReset()
  mocks.fetch.mockReset().mockResolvedValue(list())
  mocks.native.mockReset()
  mocks.available = false
  mocks.deviceId = 'phone'
})
afterEach(() => {
  harness?.cleanup()
  harness = undefined
  for (const stop of stops.splice(0)) stop()
  retainDeviceSessions([])
  vi.useRealTimers()
})

describe('phone directory uses summaries without a workspace pipe', () => {
  it('joins manual retry to the in-flight refresh, and cannot fetch again after stop or while offline', async () => {
    const response = deferred<SessionpageSessionsListResult>()
    mocks.fetch.mockReturnValue(response.promise)
    const stop = startPhoneAgentDirectorySync('phone', true)
    stops.push(stop)
    const first = stop.refresh()
    const second = stop.refresh()
    expect(first).toBe(second)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    response.resolve(list())
    await first
    stop()
    await stop.refresh()
    const offline = startPhoneAgentDirectorySync('offline', false)
    stops.push(offline)
    await offline.refresh()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('registers only the current owner’s online active phone; retry shares its poller and cleanup removes access', async () => {
    harness = createReactHarness()
    function Root({ devices }: { devices: readonly Device[] }) { usePhoneAgentDirectory(devices); return null }
    const phone = (id: string, host = true, online = true) => device(id, [], { is_online: online,
      capabilities: { host_kind: 'phone', host_runtime_capability: host ? 1 : 0, terminals: [], runtimes: host ? ['pi'] : [] } })
    const render = (owner: string, devices: Device[]) => renderWithAppProviders(harness!, createNode(Root, { devices }), { auth: { id: owner } })
    await render('owner-a', [phone('phone'), phone('offline', true, false), phone('stopped', false)])
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    await expect(retryDeviceSessions('owner-b', 'phone')).rejects.toThrow('当前账号')
    await expect(retryDeviceSessions('owner-a', 'offline')).rejects.toThrow('当前账号')
    await expect(retryDeviceSessions('owner-a', 'stopped')).rejects.toThrow('当前账号')
    await act(async () => { await retryDeviceSessions('owner-a', 'phone') })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.fetch).toHaveBeenLastCalledWith('phone')
    mocks.fetch.mockRejectedValueOnce(new Error('phone offline'))
    await act(async () => { await expect(retryDeviceSessions('owner-a', 'phone')).rejects.toThrow('phone offline') })
    expect(liveDeviceSessions().phone.error).toBe('phone offline')
    await render('owner-b', [phone('phone')])
    await expect(retryDeviceSessions('owner-a', 'phone')).rejects.toThrow('当前账号')
    await render('owner-b', [phone('phone', false)])
    await expect(retryDeviceSessions('owner-b', 'phone')).rejects.toThrow('当前账号')
    const count = mocks.fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    await render('owner-b', [phone('phone')])
    await harness.render(null)
    await expect(retryDeviceSessions('owner-b', 'phone')).rejects.toThrow('当前账号')
  })

  it('publishes the real session/DM summary into the shared directory and refreshes sequentially', async () => {
    stops.push(startPhoneAgentDirectorySync('phone', true))
    await flush()
    expect(mocks.fetch).toHaveBeenCalledWith('phone')
    expect(liveDeviceSessions().phone).toMatchObject({ ...list(), cached: false, loading: false, error: null })
    expect(liveDeviceSessions().phone.sessions[0].supported).toBe(false)
    expect(mocks.write).toHaveBeenCalledWith('phone', list())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('reads persisted summaries for an offline/stopped phone, makes no host call, and preserves the real DM address', async () => {
    mocks.read.mockResolvedValue(list())
    stops.push(startPhoneAgentDirectorySync('phone', false))
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.fetch).not.toHaveBeenCalled()
    const phone = { device_id: 'phone', is_online: false, capabilities: { host_kind: 'phone' }, session_digest: [] } as unknown as Device
    expect(deviceSessionsOf(phone, liveDeviceSessions())).toMatchObject({ ...list(), cached: true, loading: false, error: null })
  })

  it('does not let a slow cache read replace a newer real host response', async () => {
    let cache!: (value: SessionpageSessionsListResult) => void
    mocks.read.mockReturnValue(new Promise((resolve) => { cache = resolve }))
    stops.push(startPhoneAgentDirectorySync('phone', true))
    await flush()
    cache({ projects: [], sessions: [] })
    await flush()
    expect(liveDeviceSessions().phone.sessions[0].chatId).toBe('real-dm')
    expect(liveDeviceSessions().phone.cached).toBe(false)
  })

  it('keeps the known session after a failed refresh and marks its state stale', async () => {
    stops.push(startPhoneAgentDirectorySync('phone', true))
    await flush()
    mocks.fetch.mockRejectedValue(new Error('手机未连接'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(liveDeviceSessions().phone).toMatchObject({ sessions: list().sessions, cached: true, loading: false, error: '手机未连接' })
  })

  it('stops polling and ignores an in-flight reply after the owning root unmounts', async () => {
    let reply!: (value: SessionpageSessionsListResult) => void
    mocks.fetch.mockReturnValue(new Promise((resolve) => { reply = resolve }))
    const stop = startPhoneAgentDirectorySync('phone', true)
    stop()
    retainDeviceSessions([])
    reply(list())
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(liveDeviceSessions().phone).toBeUndefined()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('migrates a stopped native host without an old directory cache and keeps the real project/DM', async () => {
    mocks.available = true
    mocks.native.mockResolvedValue({ ownerId: 'owner', deviceId: 'phone', ready: false, status: 'stopped', project: list().projects[0], sessions: [{ sessionId: 'phone-session', agentUserId: 'agent-1', chatId: 'real-dm', displayName: 'Phone task', status: 'idle', lastActiveAt: null }] })
    stops.push(startPhoneAgentDirectorySync('phone', false, mocks.fetch, readLocalPhoneSessions))
    await flush()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(liveDeviceSessions().phone).toMatchObject({ projects: list().projects, sessions: [{ conversationId: 'phone-session', projectId: 'phone-project', chatId: 'real-dm', supported: false }], cached: true, loading: false })
    expect(mocks.native).toHaveBeenCalledWith({ ownerId: 'owner' })
  })

  it('preserves actual task-record capability when migrating a stopped current host', async () => {
    mocks.available = true
    mocks.native.mockResolvedValue({ ownerId: 'owner', deviceId: 'phone', taskTimeline: true, ready: false, status: 'stopped', project: list().projects[0], sessions: [{ sessionId: 'phone-session', agentUserId: 'agent-1', displayName: 'Phone task', status: 'idle' }] })
    const result = await readLocalPhoneSessions('phone')
    expect(result?.sessions[0]).toMatchObject({ conversationId: 'phone-session', supported: true })
    expect(result?.sessions[0].recordState).toBeUndefined()
  })

  it('does not read another phone or accept a native snapshot for another owner', async () => {
    mocks.available = true
    await expect(readLocalPhoneSessions('other-phone')).resolves.toBeNull()
    expect(mocks.native).not.toHaveBeenCalled()
    mocks.native.mockResolvedValue({ ownerId: 'other-owner', deviceId: 'phone', sessions: [{ sessionId: 'hidden' }] })
    await expect(readLocalPhoneSessions('phone')).rejects.toThrow('账号或设备不一致')
    expect(liveDeviceSessions().phone).toBeUndefined()
  })
})
