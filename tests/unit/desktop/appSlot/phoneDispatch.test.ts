// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { writeCachedDevices } from '../../../../apps/desktop/src/store/devicesCache'
import { retainDeviceSessions, updateDeviceSessions, liveDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { APP_SHOW_SESSION_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { phoneDispatch } from '../../../../apps/desktop/src/components/appSlot/phoneDispatch'
const rpc = vi.hoisted(() => vi.fn())
const lists = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ appDispatchOn: rpc, fetchSessionsList: lists }))
const AGENT = 'user:22222222-2222-4222-8222-222222222222'
const app = { extensionId: 'board', extensionName: 'Board' }
const device = (id: string, online = true): Device => ({ device_id: id, label: id, hostname: id, platform: 'darwin', status: 'online', is_online: online, last_seen_at: '2026-10-26T01:00:00Z', capabilities: { terminals: [], runtimes: [] } }) as Device
const session = (id = 'task-1'): SessionpageSessionSummary => ({ conversationId: id, supported: true, runtime: 'acp', agent: { userId: AGENT.slice(5) }, chatId: 'group-1' }) as SessionpageSessionSummary
const ready = (id: string, sessions: SessionpageSessionSummary[] = [session()]) => updateDeviceSessions(id, { cached: false, loading: false, error: null, sessions })
const dispatch = (context: { deviceId?: string; chatId?: string; agents?: string[] } = {}) => phoneDispatch(app, ['agents:control:all-machines'], context)
beforeEach(() => {
  localStorage.clear(); retainDeviceSessions([]); rpc.mockReset(); lists.mockReset().mockImplementation(async (deviceId: string) => ({ projects: [], sessions: liveDeviceSessions()[deviceId]?.sessions ?? [] }))
  writeCachedDevices('owner', [device('desktop')]); ready('desktop')
})

describe('phone dispatch through the existing agent directory and App RPC', () => {
  it('tells the exact task as the App, carrying queue/defer/key and the receipt', async () => {
    rpc.mockResolvedValue({ id: 'message-1', deferred: true })
    await expect(dispatch().agents.tell({ agent: AGENT, named: true }, 'hello', { delivery: 'defer', key: 'card' }))
      .resolves.toEqual({ agent: AGENT, id: 'message-1', deferred: true })
    expect(rpc).toHaveBeenCalledWith('desktop', expect.objectContaining({ kind: 'app', extensionId: 'board', extensionName: 'Board', deviceId: expect.stringMatching(/^phone-/) }),
      { action: 'message', session_ids: ['task-1'], text: 'hello', delivery: 'defer', key: 'card' })
  })
  it('refuses a named agent with narrow permission but accepts the person’s sheet pick', async () => {
    const { agents } = phoneDispatch(app, ['agents:control'], {})
    await expect(agents.tell({ agent: AGENT, named: true }, 'hello', {})).rejects.toMatchObject({ code: 'not-found' })
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ id: 'm' })
    await expect(agents.tell({ agent: AGENT, named: false }, 'hello', {})).resolves.toMatchObject({ id: 'm' })
  })
  it('bare control starts App-owned agents on a computer and tells only the agents this App started', async () => {
    const { agents } = phoneDispatch(app, ['agents:control'], {})
    rpc.mockResolvedValue({ agentId: AGENT })
    await expect(agents.spawn('work', {})).resolves.toBe(AGENT)
    ready('desktop', [{ ...session(), spawnedByExtensionId: 'another-app' }])
    await expect(agents.tell({ agent: AGENT, named: true }, 'hello', {})).rejects.toMatchObject({ code: 'not-found' })
    ready('desktop', [{ ...session(), spawnedByExtensionId: 'board' }])
    rpc.mockResolvedValue({ id: 'm' })
    await expect(agents.tell({ agent: AGENT, named: true }, 'hello', {})).resolves.toMatchObject({ agent: AGENT, id: 'm' })
  })
  it('only says not-found when every computer was read, otherwise failed', async () => {
    ready('desktop', [])
    await expect(dispatch().agents.tell({ agent: AGENT, named: true }, 'hi', {})).rejects.toMatchObject({ code: 'not-found' })
    lists.mockRejectedValueOnce(new Error('unreachable'))
    await expect(dispatch().agents.tell({ agent: AGENT, named: true }, 'hi', {})).rejects.toMatchObject({ code: 'failed' })
    ready('desktop', []); writeCachedDevices('owner', [device('desktop'), device('offline', false)])
    await expect(dispatch().agents.tell({ agent: AGENT, named: true }, 'hi', {})).rejects.toMatchObject({ code: 'failed' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('rechecks the directory after the sheet, and preserves the answering computer’s refusal', async () => {
    const { agents } = dispatch()
    ready('desktop', [session('task-new')]); rpc.mockRejectedValue(Object.assign(new Error('archived'), { code: 'not-found' }))
    await expect(agents.tell({ agent: AGENT, named: false }, 'hi', {})).rejects.toMatchObject({ code: 'not-found', message: 'archived' })
    expect(rpc.mock.calls[0][2].session_ids).toEqual(['task-new'])
  })
  it('opens the listed task with a draft, sends nothing, and offers only available composers', async () => {
    const shown = vi.fn(); window.addEventListener(APP_SHOW_SESSION_EVENT, shown, { once: true })
    expect(dispatch().local).toEqual([AGENT])
    await expect(dispatch().agents.draft({ agent: AGENT, named: true }, '')).rejects.toMatchObject({ code: 'invalid' })
    await expect(dispatch().agents.draft({ agent: AGENT, named: true }, 'please review')).resolves.toBe(AGENT)
    expect(shown.mock.calls[0][0].detail).toMatchObject({ deviceId: 'desktop', session: { conversationId: 'task-1' }, draft: { text: 'please review\n' } })
    expect(rpc).not.toHaveBeenCalled()
    updateDeviceSessions('desktop', { cached: true }); expect(dispatch().local).toEqual([])
  })
  it('lists fresh computer facts with App read scope and never invents live counters', async () => {
    const own = { ...session('own'), spawnedByExtensionId: 'board' }
    const other = { ...session('other'), agent: { userId: '33333333-3333-4333-8333-333333333333' }, spawnedByExtensionId: 'another-app' }
    // The push is still empty: listAgents must observe the agent that a successful spawn just created.
    ready('desktop', [])
    lists.mockResolvedValue({ projects: [], sessions: [own, other] })
    const owned = await phoneDispatch(app, ['agents:read'], {}).listAgents()
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ sessionId: 'own', deviceId: 'desktop', agentId: AGENT, spawnedByThisExtension: true, contextTokens: null, pendingPermissionCount: null })
    expect(await phoneDispatch(app, ['agents:read:all-machines'], {}).listAgents()).toHaveLength(2)
  })
  it('starts through the App spawn route on the context, group, latest or person-picked computer', async () => {
    writeCachedDevices('owner', [device('older'), { ...device('latest'), last_seen_at: '2026-10-26T01:01:00Z' }])
    ready('older'); ready('latest', [])
    expect(dispatch().spawnOn).toBe('latest')
    expect(dispatch({ deviceId: 'older' }).spawnOn).toBe('older')
    expect(dispatch({ chatId: 'group-1' }).spawnOn).toBe('older')
    expect(dispatch({ agents: [AGENT] }).spawnOn).toBe('older')
    rpc.mockResolvedValue({ agentId: AGENT })
    await expect(dispatch().agents.spawn('work', { title: 'Card' }, 'older')).resolves.toBe(AGENT)
    expect(rpc.mock.calls[0][0]).toBe('older')
    expect(rpc.mock.calls[0][2]).toEqual({ action: 'spawn', prompt: 'work', spawn: { title: 'Card' } })
    await expect(dispatch().agents.spawn('work', {}, 'gone')).rejects.toMatchObject({ code: 'failed' })
  })
})
