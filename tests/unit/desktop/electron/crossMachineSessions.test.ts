/**
 * agent 的 session_* 跨机器(owner 2026-09-30 拍板):「去哪台机器、怎么去、去不了怎么说」,以及对端怎么答。
 *
 * 可见域:cross-machine-sessions.ts(假的机器清单、假的请求方、假的宿主)。判的是这一层的裁决:
 * 发出去之前就说清的(不在名下、离线、是本机),发出去之后才知道的(太旧、没回音、够不着、对端报错),
 * 会话地址怎么找到它所在的机器,子会话怎么并进来,对端怎么认载荷、把动作交给宿主。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { RemoteSessionCaller } from '@gugu/session-core/session-record/contract'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '../../../../apps/desktop/src/session/shared/extensions/host-actions'
import {
  createCrossMachineSessions,
  CrossMachineError,
  parseAgentSessionRequest,
  remoteActionTimeoutMs,
  type AgentSessionHost,
  type CrossMachineDeps,
} from '../../../../apps/desktop/electron/cross-machine-sessions'
import { DeviceRpcChannelError, DeviceRpcTimeoutError } from '../../../../packages/core/src/cloud/deviceRpcRequester'

const NOW = Date.parse('2026-09-30T04:00:00.000Z')

function device(id: string, label: string, online: boolean, lastSeen = '2026-09-30T03:58:00.000Z'): Device {
  return {
    device_id: id,
    label,
    hostname: label,
    platform: 'darwin',
    status: online ? 'online' : 'offline',
    last_seen_at: lastSeen,
    is_online: online,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
  } as Device
}

const CALLER: RemoteSessionCaller = {
  deviceId: 'dev-a',
  deviceLabel: 'this box',
  sessionId: 'caller-session',
  agentUserId: 'agent-a',
  name: 'Claude 1',
  harness: 'claude',
  transport: 'acp',
  model: null,
  platformModel: null,
}

/**
 * 那台机器路由表上的一问(`taskhost.call {channel, args}`),拆成 channel + `{caller, action}` 交给用例答;
 * 列会话、归档那两问的 args 原样在 `args` 里。
 */
type Call = (
  deviceId: string,
  channel: string,
  payload: { caller: RemoteSessionCaller; action: { action: string } & Record<string, unknown>; args: unknown[] },
) => Promise<{ result?: unknown; error?: { code: string; message: string } }>

function makeCrossMachine(reply: Call = async () => ({ result: { ok: true } }), overrides: Partial<CrossMachineDeps> = {}) {
  const call = vi.fn(reply)
  const wire = vi.fn(async (deviceId: string, type: string, body: { channel: string; args: unknown[] }) => {
    expect(type).toBe('taskhost.call')
    const [caller, action] = body.args as [RemoteSessionCaller, { action: string }]
    const answer = await call(deviceId, body.channel, { caller, action, args: body.args })
    return answer.error ? answer : { result: { value: answer.result } }
  })
  const deps: CrossMachineDeps = {
    thisDeviceId: async () => 'dev-a',
    listDevices: async () => [
      device('dev-a', 'this box', true),
      device('dev-b', 'gpu server', true),
      device('dev-c', 'laptop', false, '2026-09-30T01:00:00.000Z'),
    ],
    lookupAgents: async () => [],
    requester: { call: wire as unknown as CrossMachineDeps['requester']['call'] },
    now: () => NOW,
    ...overrides,
  }
  return { xm: createCrossMachineSessions(deps), call }
}

const actions = (call: ReturnType<typeof vi.fn>) =>
  call.mock.calls.map(([deviceId, , payload]) => [deviceId, (payload as { action: { action: string } }).action.action])

describe('reaching another machine', () => {
  it('uses the shared task-host predicate for activity targets and keeps offline hosts', async () => {
    const phone = device('phone', 'Phone', false)
    phone.capabilities = { ...phone.capabilities, host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] }
    const actionOnly = device('actions-only', 'No task host', true)
    actionOnly.capabilities = { ...actionOnly.capabilities, host_kind: 'phone' }
    const oldComputer = device('old', 'Older computer', true)
    delete oldComputer.capabilities.host_runtime_capability
    const { xm, call } = makeCrossMachine(undefined, { listDevices: async () => [oldComputer, phone, actionOnly] })
    expect((await xm.activityDevices()).map(d => [d.device_id, d.online])).toEqual([['old', true], ['phone', false]])
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses file handoff to an older or unknown receiver before any message RPC, without blocking text', async () => {
    for (const protocol of [undefined, 10, 11]) {
      const target = device('dev-b', 'receiver', true)
      target.capabilities.remote_protocol = protocol
      const { xm, call } = makeCrossMachine(undefined, { listDevices: async () => [device('dev-a', 'sender', true), target] })
      if (protocol === 11) await xm.assertFileHandoffSupported(['dev-b'])
      else await expect(xm.assertFileHandoffSupported(['dev-b'])).rejects.toMatchObject({ code: 'SESSION_DEVICE_OUTDATED' })
      expect(call).not.toHaveBeenCalled()
      await xm.runOnDevice('dev-b', CALLER, { action: 'message', session_ids: ['receiver'], text: 'plain text' })
      expect(call).toHaveBeenCalledOnce()
    }
  })
  it('lists this machine first, then online machines', async () => {
    const { xm } = makeCrossMachine()
    expect((await xm.listDeviceRows()).map((row) => [row.device_id, row.this_machine, row.online])).toEqual([
      ['dev-a', true, true],
      ['dev-b', false, true],
      ['dev-c', false, false],
    ])
  })

  it('advertises a phone task runtime even without native file actions', async () => {
    const phone = device('phone', 'phone', true)
    phone.capabilities = { ...phone.capabilities, host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] }
    const { xm } = makeCrossMachine(undefined, { listDevices: async () => [phone] })
    expect(await xm.listDeviceRows()).toEqual([expect.objectContaining({ device_id: 'phone',
      task_runtime: { capability: 1, runtimes: ['pi'] } })])
  })

  it('keeps an older computer with no runtime capability field usable for tasks', async () => {
    const computer = device('old-computer', 'older computer', true)
    delete computer.capabilities.host_runtime_capability
    const { xm, call } = makeCrossMachine(undefined, { listDevices: async () => [computer] })
    await expect(xm.runOnDevice('old-computer', CALLER, { action: 'spawn', prompt: 'work' })).resolves.toMatchObject({ ok: true, device_id: 'old-computer' })
    expect(call).toHaveBeenCalledOnce()
  })

  it('keeps an owned phone visible when its task host is off and distinguishes it from an unknown device', async () => {
    const phone = device('phone', '主人的手机', true)
    phone.capabilities = { ...phone.capabilities, host_kind: 'phone', host_runtime_capability: 0, runtimes: [] }
    const { xm, call } = makeCrossMachine(undefined, { listDevices: async () => [device('dev-a', 'sender', true), phone] })
    expect(await xm.listDeviceRows()).toContainEqual(expect.objectContaining({ device_id: 'phone', online: true,
      task_runtime: { capability: 0, runtimes: [] } }))
    for (const action of [{ action: 'spawn', prompt: 'work' }, { action: 'message', session_ids: ['s'], text: 'work' }]) {
      await expect(xm.runOnDevice('phone', CALLER, action)).rejects.toMatchObject({ code: 'device_no_task_runtime',
        message: expect.stringMatching(/主人的手机.*device:phone.*请主人.*那台设备.*开启任务宿主.*其他设备不能代调/) })
    }
    await expect(xm.messageDeps(async () => CALLER).assertReachable(['phone'])).rejects.toMatchObject({ code: 'device_no_task_runtime' })
    await expect(xm.runOnDevice('stranger', CALLER, { action: 'spawn', prompt: 'work' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_UNKNOWN' })
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses reuse when a known executor’s host stops, without hiding the device or sending a request', async () => {
    const phone = device('phone', '手机', true)
    phone.capabilities = { ...phone.capabilities, host_kind: 'phone', host_runtime_capability: 1, runtimes: ['pi'] }
    const { xm, call } = makeCrossMachine(async () => ({ result: { session_id: 'phone-task' } }),
      { listDevices: async () => [phone] })
    await xm.runOnDevice('phone', CALLER, { action: 'spawn', prompt: 'work' })
    phone.capabilities = { ...phone.capabilities, host_runtime_capability: 0, runtimes: [] }
    call.mockClear()
    const remote = xm.messageDeps(async () => CALLER)
    expect((await remote.locateSessions(['phone-task'])).found.get('phone-task')).toBe('phone')
    await expect(remote.assertReachable(['phone'])).rejects.toMatchObject({ code: 'device_no_task_runtime' })
    expect(call).not.toHaveBeenCalled()
    expect(await xm.withRemoteChildren([], undefined, async () => CALLER)).toEqual([])
    expect((await xm.sessionsElsewhere(null)).unreached).toEqual([expect.objectContaining({ deviceId: 'phone', detail: expect.stringContaining('开启任务宿主') })])
    await xm.appCall({ extensionId: 'app', extensionName: 'App' }, 'phone', {
      action: 'app_call', call_id: 'c-1', session_id: 's', version: '0.7.0', method: 'writeData', args: { path: 'journal.json', content: '{}' },
    })
    expect(call).toHaveBeenCalledOnce()
  })

  it('asks that machine\'s task-page router: agentSession.<action>(caller, action), one call, no window', async () => {
    const { xm, call } = makeCrossMachine()
    await expect(xm.call('dev-b', CALLER, { action: 'get', session_id: 's' })).resolves.toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('dev-b', 'agentSession.get', expect.objectContaining({ args: [CALLER, { action: 'get', session_id: 's' }] }))
  })

  it('refuses an offline machine before sending anything, naming it and how long it has been gone', async () => {
    const { xm, call } = makeCrossMachine()
    const error = await xm.call('dev-c', CALLER, { action: 'spawn', prompt: 'x' }).catch((e: unknown) => e)
    expect((error as CrossMachineError).code).toBe('SESSION_DEVICE_OFFLINE')
    expect((error as Error).message).toContain('"laptop" (device:dev-c) is offline (last seen 3 h ago); nothing was sent there')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a machine that is not this account\'s, and this machine itself', async () => {
    const { xm, call } = makeCrossMachine()
    await expect(xm.call('dev-zzz', CALLER, { action: 'get' })).rejects.toThrow(/not one of this account's machines — session_devices lists them/)
    await expect(xm.call('dev-a', CALLER, { action: 'get' })).rejects.toThrow(/is this machine/)
    expect(call).not.toHaveBeenCalled()
  })

  it('says a machine is too old when it has no taskhost.call (protocol 5) or no agentSession.* on its router (protocol 6)', async () => {
    const five = makeCrossMachine(async () => ({ error: { code: 'unknown_method', message: 'unknown device RPC type' } }))
    await expect(five.xm.call('dev-b', CALLER, { action: 'spawn', prompt: 'x' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_OUTDATED' })
    const six = makeCrossMachine(async () => ({ error: { code: 'call_failed', message: "No handler registered for 'agentSession.spawn'" } }))
    await expect(six.xm.call('dev-b', CALLER, { action: 'spawn', prompt: 'x' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_OUTDATED' })
  })

  it('does not claim nothing happened when the machine went quiet after the request left', async () => {
    const { xm } = makeCrossMachine(async () => { throw new DeviceRpcTimeoutError('no reply') })
    const error = await xm.call('dev-b', CALLER, { action: 'spawn', prompt: 'x' }).catch((e: unknown) => e)
    expect((error as CrossMachineError).code).toBe('SESSION_DEVICE_NO_ANSWER')
    expect((error as Error).message).toContain('the spawn may or may not have happened there')
  })

  it('tells an SSH machine that needs a sign-in apart from one that is simply unreachable', async () => {
    const signIn = makeCrossMachine(async () => { throw new DeviceRpcChannelError('ssh link: signInRequired', 'signInRequired') })
    await expect(signIn.xm.call('dev-b', CALLER, { action: 'get' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_SIGN_IN_REQUIRED' })
    const down = makeCrossMachine(async () => { throw new DeviceRpcChannelError('could not subscribe', 'unreachable') })
    await expect(down.xm.call('dev-b', CALLER, { action: 'get' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_UNREACHABLE' })
  })

  it('carries the remote tool error back, prefixed with the machine it came from', async () => {
    const { xm } = makeCrossMachine(async () => ({ error: { code: 'session_action_failed', message: 'target task not found on this machine' } }))
    await expect(xm.call('dev-b', CALLER, { action: 'spawn', prompt: 'x' }))
      .rejects.toThrow('on "gpu server" (device:dev-b): target task not found on this machine')
  })

  it('waits longer for actions that may wake a session or probe a model catalog', () => {
    expect(remoteActionTimeoutMs({ action: 'message' })).toBeGreaterThan(remoteActionTimeoutMs({ action: 'get' }))
    // app_install { device }: that machine answers when the person's consent clock settles — never cut off before it.
    expect(remoteActionTimeoutMs({ action: 'app_install' })).toBeGreaterThan(INSTALL_CONSENT_HUMAN_WINDOW_MS)
  })
})

describe('doing things on another machine', () => {
  it('passes nest through: a child on another machine can hang under the caller', async () => {
    const { xm, call } = makeCrossMachine(async () => ({ result: { session_id: 'child-1', parent_session_id: 'caller-session' } }))
    await xm.runOnDevice('dev-b', CALLER, { action: 'spawn', prompt: 'x', nest: true })
    expect(call.mock.calls[0]![2].action).toEqual({ action: 'spawn', prompt: 'x', nest: true })
  })

  it('marks a spawned child with its machine and reaches it later without searching', async () => {
    const { xm, call } = makeCrossMachine(async (_deviceId, _type, { action }) =>
      action.action === 'spawn' ? { result: { session_id: 'child-1' } } : { result: { session_id: 'child-1', status: 'idle' } })
    await expect(xm.runOnDevice('dev-b', CALLER, { action: 'spawn', prompt: 'x' }))
      .resolves.toEqual({ session_id: 'child-1', device_id: 'dev-b', device_label: 'gpu server' })
    await expect(xm.runOnSession('child-1', CALLER, { action: 'get', session_id: 'child-1' }))
      .resolves.toEqual({ session_id: 'child-1', status: 'idle', device_id: 'dev-b', device_label: 'gpu server' })
    expect(actions(call)).toEqual([['dev-b', 'spawn'], ['dev-b', 'get']])
  })

  it('types the machine on another machine\'s peer rows and remembers where those sessions are', async () => {
    const { xm, call } = makeCrossMachine(async (_deviceId, _type, { action }) =>
      action.action === 'peers' ? { result: [{ sessionId: 's-b' }] } : { result: { ok: true } })
    await expect(xm.runOnDevice('dev-b', CALLER, { action: 'peers' }))
      .resolves.toEqual([{ sessionId: 's-b', device_id: 'device:dev-b', device_label: 'gpu server' }])
    await xm.runOnSession('s-b', CALLER, { action: 'stop', session_id: 's-b' })
    expect(actions(call)).toEqual([['dev-b', 'peers'], ['dev-b', 'stop']])
  })

  it('finds an unknown session by asking the online machines, and names what it could not check when it is nowhere', async () => {
    const found = makeCrossMachine(async (_deviceId, _type, { action }) =>
      action.action === 'locate' ? { result: { session_ids: ['s-b'] } } : { result: { ok: true } })
    await found.xm.runOnSession('s-b', CALLER, { action: 'get', session_id: 's-b' })
    expect(actions(found.call)).toEqual([['dev-b', 'locate'], ['dev-b', 'get']])

    const nowhere = makeCrossMachine(async () => { throw new DeviceRpcTimeoutError('no reply') })
    await expect(nowhere.xm.runOnSession('ghost', CALLER, { action: 'get', session_id: 'ghost' })).rejects.toThrow(
      'session:ghost is not a session on this machine or on any of this account\'s online machines — could not check: '
      + '"laptop" (device:dev-c) (offline, last seen 3 h ago), "gpu server" (device:dev-b) (no answer).',
    )
  })

  it('forgets a session its machine no longer has, so the next call searches again', async () => {
    let gone = false
    const { xm, call } = makeCrossMachine(async (_deviceId, _type, { action }) => {
      if (action.action === 'locate') return { result: { session_ids: gone ? [] : ['s-b'] } }
      gone = true
      return { error: { code: 'session_action_failed', message: 'session not found on this machine — …' } }
    })
    await expect(xm.runOnSession('s-b', CALLER, { action: 'get', session_id: 's-b' })).rejects.toThrow('session not found on this machine')
    await expect(xm.runOnSession('s-b', CALLER, { action: 'get', session_id: 's-b' })).rejects.toThrow('is not a session on this machine or on any')
    expect(actions(call)).toEqual([['dev-b', 'locate'], ['dev-b', 'get'], ['dev-b', 'locate']])
  })

  it('adds the children spawned on online machines to the local list, newest first', async () => {
    const { xm } = makeCrossMachine(async () => ({ result: [{ session_id: 'remote-child', last_active_at: '2026-09-30T03:00:00.000Z' }] }))
    const local = [{ session_id: 'local-child', last_active_at: '2026-09-30T02:00:00.000Z' }]
    await expect(xm.withRemoteChildren(local, undefined, async () => CALLER)).resolves.toEqual([
      { session_id: 'remote-child', last_active_at: '2026-09-30T03:00:00.000Z', device_id: 'dev-b', device_label: 'gpu server' },
      local[0],
    ])
  })

  it('asks every online machine for the children of a named session — they can hang under it from anywhere', async () => {
    const { xm, call } = makeCrossMachine(async () => ({ result: [] }))
    await xm.withRemoteChildren([], 'parent-on-c', async () => CALLER)
    expect(call.mock.calls.map(([deviceId, , { action }]) => [deviceId, action])).toEqual([
      ['dev-b', { action: 'children', session_id: 'parent-on-c' }],
    ])
  })

  it('keeps the local children when the machine list cannot be read', async () => {
    const { xm, call } = makeCrossMachine(undefined, { listDevices: async () => { throw new Error('offline') } })
    const local = [{ session_id: 'local-child' }]
    await expect(xm.withRemoteChildren(local, undefined, async () => CALLER)).resolves.toBe(local)
    expect(call).not.toHaveBeenCalled()
  })
})

describe('session_message to another machine', () => {
  it('reaches this account\'s agents by Agent ID and by 咕咕号', async () => {
    const { xm } = makeCrossMachine(undefined, { lookupAgents: async () => [{ userId: 'agent-b', guguNumber: 4321, deviceId: 'dev-b' }] })
    const found = await xm.messageDeps(async () => CALLER).locateAgents({ userIds: ['agent-b', 'stranger'], numbers: [4321] })
    expect(found.byUserId.get('agent-b')).toBe('dev-b')
    expect(found.byUserId.has('stranger')).toBe(false)
    expect(found.numberToUserId.get(4321)).toBe('agent-b')
  })

  it('sends to sessions there with the message action — the only delivery between machines', async () => {
    const { xm, call } = makeCrossMachine(async () => ({ result: { recipients: [{ to: 'session:s-b', status: 'delivered' }] } }))
    const results = await xm.messageDeps(async () => CALLER).deliver('dev-b', { sessionIds: ['s-b'], text: 'hi', said: {} })
    expect(results).toEqual([{ to: 'session:s-b', status: 'delivered' }])
    // 发信方说的发完以后去向与回的是哪条(owner 10-17)放进同一个 message 动作;不说就与从前逐字段相同。
    await xm.messageDeps(async () => CALLER).deliver('dev-b', { sessionIds: ['s-b'], text: 'hi', said: { then: 'wait', reply_to_message_id: 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f' } })
    expect(call.mock.calls.map(([deviceId, type, { action }]) => [deviceId, type, action])).toEqual([
      ['dev-b', 'agentSession.message', { action: 'message', session_ids: ['s-b'], text: 'hi' }],
      ['dev-b', 'agentSession.message', { action: 'message', session_ids: ['s-b'], text: 'hi', then: 'wait', reply_to_message_id: 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f' }],
    ])
  })

  it('an Agent ID on that machine is its session there, read from that machine\'s session list', async () => {
    const list = { projects: [], sessions: [{ conversationId: 's-b', agent: { userId: 'agent-b' } }, { conversationId: 's-c', agent: null }] }
    const { xm, call } = makeCrossMachine(async () => ({ result: list }))
    expect(await xm.messageDeps(async () => CALLER).sessionsOfAgents('dev-b', ['agent-b', 'agent-x'])).toEqual(new Map([['agent-b', 's-b']]))
    expect(call.mock.calls.map(([deviceId, type]) => [deviceId, type])).toEqual([['dev-b', 'sessionTimeline.sessionsList']])
  })

  it('a machine whose list carries no agents (protocol 6) is too old to be reached by Agent ID — said, not "not your agent"', async () => {
    const { xm } = makeCrossMachine(async () => ({ result: { projects: [], sessions: [{ conversationId: 's-b' }] } }))
    await expect(xm.messageDeps(async () => CALLER).sessionsOfAgents('dev-b', ['agent-b'])).rejects.toMatchObject({ code: 'SESSION_DEVICE_OUTDATED' })
  })
})

describe('answering another machine', () => {
  function host(overrides: Partial<AgentSessionHost> = {}) {
    return {
      peers: vi.fn(async () => ['peer']),
      run: vi.fn(async () => ({ ran: true })),
      app: vi.fn(async () => ({ id: 'm-1' })),
      appSpawn: vi.fn(async () => ({ agentId: 'user:a-new' })),
      appReadFile: vi.fn(),
      appCall: vi.fn(),
      ...overrides,
    }
  }

  it('hands each action to the host part that owns it', async () => {
    const { xm } = makeCrossMachine()
    const h = host()
    await expect(xm.answer('peers', CALLER, { action: 'peers' }, h)).resolves.toEqual(['peer'])
    await expect(xm.answer('get', CALLER, { action: 'get', session_id: 's' }, h)).resolves.toEqual({ ran: true })
    expect(h.run).toHaveBeenCalledWith(CALLER, { action: 'get', session_id: 's' })
  })

  it('starts an App agent through the App spawn core, with the same checked options and no borrowed session caller', async () => {
    const APP = { kind: 'app', deviceId: 'phone', deviceLabel: 'phone', extensionId: 'board', extensionName: 'Board' } as const
    const { xm } = makeCrossMachine()
    const h = host()
    const action = { action: 'spawn', prompt: 'work', spawn: { model: 'platform:model', transport: 'acp', title: 'Card' } } as const
    await expect(xm.answer('spawn', APP, action, h)).resolves.toEqual({ agentId: 'user:a-new' })
    expect(h.appSpawn).toHaveBeenCalledWith(APP, action)
    expect(h.run).not.toHaveBeenCalled()
    expect(parseAgentSessionRequest('spawn', APP, { ...action, spawn: { transport: 'other' } })).toHaveProperty('error')
    expect(parseAgentSessionRequest('spawn', APP, { ...action, spawn: { unknown: true } })).toHaveProperty('error')
    expect(parseAgentSessionRequest('spawn', APP, { ...action, prompt: '' })).toHaveProperty('error')
  })

  it('refuses a malformed request', async () => {
    const { xm } = makeCrossMachine()
    const h = host()
    await expect(xm.answer('get', undefined, { action: 'get' }, h)).rejects.toMatchObject({ code: 'invalid_payload', message: 'caller is required' })
    await expect(xm.answer('get', CALLER, { action: 'stop' }, h)).rejects.toMatchObject({ code: 'invalid_payload' })
  })

  it('returns the host\'s error text, and remembers where the caller is so a reply needs no search', async () => {
    const { xm, call } = makeCrossMachine()
    await expect(xm.answer('spawn', CALLER, { action: 'spawn' }, host({ run: async () => { throw new Error('target task is archived') } })))
      .rejects.toMatchObject({ code: 'session_action_failed', message: 'target task is archived' })
    // 带码的错误码照用(App 发消息的 not-found、会话直投的 SESSION_DIRECT_*):发起方看到与本机同一个码。
    const coded = Object.assign(new Error('session:s is not an agent on this machine'), { code: 'not-found' })
    await expect(xm.answer('get', CALLER, { action: 'get' }, host({ run: async () => { throw coded } })))
      .rejects.toMatchObject({ code: 'not-found', message: 'session:s is not an agent on this machine' })
    const { found } = await xm.locateSessions([CALLER.sessionId], CALLER)
    expect(found.get(CALLER.sessionId)).toBe('dev-a')
    expect(call).not.toHaveBeenCalled()
  })
})

describe('agentSession.<action> arguments', () => {
  const APP = { kind: 'app', deviceId: 'dev-a', deviceLabel: 'this box', extensionId: 'radar', extensionName: 'Radar' } as const
  const READ = { action: 'read_file', session_id: 's', path: 'renders/cut.mp4', offset: 0, length: 524288 } as const
  const CHUNK = { path: 'renders/cut.mp4', size: 3, etag: '9-3', offset: 0, data: 'YWJj' }

  it('keeps only the caller facts it knows', () => {
    expect(parseAgentSessionRequest('get', { ...CALLER, extra: 'ignored' }, { action: 'get', session_id: 's' }))
      .toEqual({ caller: CALLER, action: { action: 'get', session_id: 's' } })
  })

  it('refuses a request without a caller device and session, or whose action is not the method it came on', () => {
    expect(parseAgentSessionRequest('get', { transport: 'acp' }, { action: 'get' })).toEqual({ error: 'caller.deviceId is required' })
    expect(parseAgentSessionRequest('get', { deviceId: 'dev-a', transport: 'acp' }, { action: 'get' })).toEqual({ error: 'caller.sessionId is required' })
    expect(parseAgentSessionRequest('get', CALLER, {})).toEqual({ error: "action must be { action: 'get', … }" })
    expect(parseAgentSessionRequest('get', { ...CALLER, transport: 'web' }, { action: 'get' }))
      .toEqual({ error: 'caller.transport must be acp or pty' })
  })

  it('an App has a page\'s call done on the machine of its session: the verb and its args, the id of the call and its version', () => {
    const CALL = { action: 'app_call', call_id: 'c-1', session_id: 's', version: '0.7.0', method: 'callProgram', args: { name: 'graph', arguments: { root: '/x' } } } as const
    expect(parseAgentSessionRequest('app_call', { ...APP, extra: 1 }, { ...CALL, junk: 1 })).toEqual({ caller: APP, action: CALL })
    for (const bad of [{ call_id: '' }, { version: 1 }, { method: undefined }, { args: [1] }, { args: undefined }, { session_id: 2 }]) {
      expect(parseAgentSessionRequest('app_call', APP, { ...CALL, ...bad })).toHaveProperty('error')
    }
    expect(parseAgentSessionRequest('app_call', CALLER, CALL))
      .toEqual({ error: 'app_call is for an App on another machine; an agent works on its own machine' })
  })

  it('an App may only send one session a message or read a chunk of a file — the table says which methods take an App', () => {
    // owner 10-14: no rehearsal any more — an older machine's check that sends `rehearsal: true` is not read, and its
    // message is delivered for real (a known cost, 148 10-14; the PR says so too).
    expect(parseAgentSessionRequest('message', { ...APP, extra: 'x' }, { action: 'message', session_ids: ['s'], text: 'hi', key: 'k', delivery: 'queue', rehearsal: true, junk: 1 }))
      .toEqual({ caller: APP, action: { action: 'message', session_ids: ['s'], text: 'hi', key: 'k', delivery: 'queue' } })
    expect(parseAgentSessionRequest('message', APP, { action: 'message', session_ids: ['s'], text: 'hi', delivery: 'attach' }))
      .toEqual({ error: 'delivery is queue or defer' })
    expect(parseAgentSessionRequest('spawn', APP, { action: 'spawn', prompt: 'x' }))
      .toEqual({ caller: APP, action: { action: 'spawn', prompt: 'x', spawn: {} } })
    expect(parseAgentSessionRequest('read_file', APP, { ...READ, junk: 1 })).toEqual({ caller: APP, action: READ })
    expect(parseAgentSessionRequest('read_file', APP, { ...READ, offset: '0' }))
      .toEqual({ error: 'read_file names a session (session_id), a path in its working copy, an offset and a length' })
    expect(parseAgentSessionRequest('read_file', CALLER, READ))
      .toEqual({ error: 'read_file is for an App on another machine; an agent works on its own machine' })
    expect(parseAgentSessionRequest('message', APP, { action: 'message', session_ids: ['a', 'b'], text: 'hi' }))
      .toEqual({ error: 'an App message names one session (session_ids: [id]) and text' })
    expect(parseAgentSessionRequest('message', { ...APP, extensionName: '' }, { action: 'message', session_ids: ['s'], text: 'hi' }))
      .toEqual({ error: 'an App caller needs extensionId and extensionName' })
  })

  it('hands an App\'s message and file read to the host\'s App parts, never to the session part', async () => {
    const { xm } = makeCrossMachine()
    const run = vi.fn()
    const app = vi.fn(async () => ({ id: 'm-1' }))
    const appReadFile = vi.fn(async () => CHUNK)
    const appCall = vi.fn()
    await expect(xm.answer('message', APP, { action: 'message', session_ids: ['s'], text: 'hi' }, {
      peers: vi.fn(), run, app, appSpawn: vi.fn(), appReadFile, appCall,
    })).resolves.toEqual({ id: 'm-1' })
    await expect(xm.answer('read_file', APP, READ, { peers: vi.fn(), run, app, appSpawn: vi.fn(), appReadFile, appCall })).resolves.toEqual(CHUNK)
    // A page's call on that machine (its program, its data folder): its own part, the verb and args as the page gave them.
    const CALL = { action: 'app_call', call_id: 'c-1', session_id: 's', version: '0.7.0', method: 'writeData', args: { path: 'journal.json', content: '{}' } } as const
    appCall.mockResolvedValueOnce(undefined)
    await expect(xm.answer('app_call', APP, CALL, { peers: vi.fn(), run, app, appSpawn: vi.fn(), appReadFile, appCall })).resolves.toBeUndefined()
    expect(appCall).toHaveBeenCalledWith(APP, CALL)
    expect(app).toHaveBeenCalledWith(APP, { action: 'message', session_ids: ['s'], text: 'hi' })
    expect(appReadFile).toHaveBeenCalledWith(APP, READ)
    expect(run).not.toHaveBeenCalled()
  })

  it('an App reads a chunk on the machine it names, asked as that App', async () => {
    const { xm, call } = makeCrossMachine(async () => ({ result: CHUNK }))
    await expect(xm.appReadFile({ extensionId: 'radar', extensionName: 'Radar' }, 'dev-b', READ)).resolves.toEqual(CHUNK)
    expect(call).toHaveBeenCalledWith('dev-b', 'agentSession.read_file', { caller: APP, action: READ, args: [APP, READ] })
  })
})

// owner 2026-10-01「一起收」「链路统一」:归档 / 删除「连同子会话」按父子关系找后代 —— 别的机器报来会话表,
// 每一条在它那台机器上单独收(与手机同一套动词)。
describe('the family across machines', () => {
  it('lists every online machine; an offline one is named only if it was online after the tree began', async () => {
    const { xm, call } = makeCrossMachine(async (_deviceId, type) => type === 'sessionTimeline.sessionsList'
      ? {
        result: {
          projects: [],
          sessions: [{ conversationId: 'b-child', projectId: 'pb', parentConversationId: 'p', spawnedByConversationId: 'p' }],
        },
      }
      : { result: {} })
    // laptop 01:00 还在线:树 00:30 建的就可能有它的 child,02:00 建的不可能。
    const early = await xm.sessionsElsewhere('2026-09-30T00:30:00Z')
    // 整行交回(界面那份列表的行),读的一方取自己要的。
    expect(early.sessions).toEqual([{
      deviceId: 'dev-b',
      label: 'gpu server',
      session: { conversationId: 'b-child', projectId: 'pb', parentConversationId: 'p', spawnedByConversationId: 'p' },
      listsAgents: false,
    }])
    expect(early.unreached).toEqual([{
      deviceId: 'dev-c',
      label: 'laptop',
      detail: '"laptop" (device:dev-c) is offline (last seen 3 h ago)',
    }])
    expect((await xm.sessionsElsewhere('2026-09-30T02:00:00Z')).unreached).toEqual([])
    // The second read within seconds reuses the first answer from dev-b.
    expect(call.mock.calls.map(([deviceId, type]) => [deviceId, type])).toEqual([['dev-b', 'sessionTimeline.sessionsList']])
  })

  it('names an online machine that does not answer', async () => {
    const { xm } = makeCrossMachine(async () => {
      throw new DeviceRpcTimeoutError('no reply')
    })
    expect((await xm.sessionsElsewhere('2026-09-30T02:00:00Z')).unreached).toEqual([{
      deviceId: 'dev-b',
      label: 'gpu server',
      detail: expect.stringContaining('"gpu server" (device:dev-b) did not answer within 30 s'),
    }])
  })

  it('archives one session there with the method the phone uses, says why it did not, and refuses an offline machine', async () => {
    const { xm, call } = makeCrossMachine(async (_deviceId, _type, { args }) =>
      (args[0] as { conversationId: string }).conversationId === 's1'
        ? { result: { ok: true, value: {} } }
        : { result: { ok: false, error: { code: 'not_found', message: 'no such session' } } })
    await xm.archiveOn('dev-b', 's1')
    expect(call.mock.calls.map(([deviceId, type, { args }]) => [deviceId, type, args])).toEqual([
      ['dev-b', 'sessionTimeline.sessionUpdate', [{ conversationId: 's1', archived: true }]],
    ])
    await expect(xm.archiveOn('dev-b', 's2')).rejects.toMatchObject({ code: 'not_found', message: 'on device:dev-b: no such session' })
    await expect(xm.archiveOn('dev-c', 's3')).rejects.toThrow('is offline')
  })

  it('an App here tells a session there: the message method, the App as caller', async () => {
    const { xm, call } = makeCrossMachine(async () => ({ result: { id: 'm-9' } }))
    await expect(xm.appMessage({ extensionId: 'radar', extensionName: 'Radar' }, 'dev-b', 's-b', 'hi', { delivery: 'defer', key: 'k' })).resolves.toEqual({ id: 'm-9' })
    expect(call.mock.calls.map(([deviceId, type, { args }]) => [deviceId, type, args])).toEqual([[
      'dev-b',
      'agentSession.message',
      [
        { kind: 'app', deviceId: 'dev-a', deviceLabel: 'this box', extensionId: 'radar', extensionName: 'Radar' },
        { action: 'message', session_ids: ['s-b'], text: 'hi', delivery: 'defer', key: 'k' },
      ],
    ]])
  })
})

// #7199 云电脑休眠中 ≠ 离线:发过去之前先叫醒,醒了照常发;醒不来说清是哪台、为什么,什么都不发。
describe('a sleeping cloud computer', () => {
  it('does not wake a paused host to inspect or locate a session, even with stale online presence', async () => {
    for (const online of [true, false]) {
      const wakeCloudComputer = vi.fn(async () => true)
      const { xm, call } = makeCrossMachine(undefined, {
        listDevices: async () => [device('dev-a', 'this box', true), device('dev-c', 'cloud', online)],
        cloudComputerState: async () => ({ state: 'asleep', deviceId: 'dev-c', error: null, since: null }),
        wakeCloudComputer,
      })
      await expect(xm.runOnDevice('dev-c', CALLER, { action: 'get', session_id: 'child' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_OFFLINE' })
      await expect(xm.call('dev-c', CALLER, { action: 'locate', session_ids: ['child'] })).rejects.toMatchObject({ code: 'SESSION_DEVICE_OFFLINE' })
      expect(wakeCloudComputer).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    }
  })
  it('wakes it, then sends as usual once it is online', async () => {
    let online = false
    const wakeCloudComputer = vi.fn(async (deviceId: string) => {
      expect(deviceId).toBe('dev-c')
      online = true
      return true
    })
    const { xm, call } = makeCrossMachine(undefined, {
      listDevices: async () => [device('dev-a', 'this box', true), device('dev-c', '云电脑', online)],
      wakeCloudComputer,
    })
    await expect(xm.call('dev-c', CALLER, { action: 'spawn', prompt: 'x' })).resolves.toEqual({ ok: true })
    expect(wakeCloudComputer).toHaveBeenCalledTimes(1)
    expect(actions(call)).toEqual([['dev-c', 'spawn']])
  })

  it('says it could not be woken and sends nothing', async () => {
    const { xm, call } = makeCrossMachine(undefined, {
      wakeCloudComputer: async () => { throw new Error('积分已用完') },
    })
    const error = await xm.call('dev-c', CALLER, { action: 'spawn', prompt: 'x' }).catch((e: unknown) => e)
    expect((error as CrossMachineError).code).toBe('SESSION_DEVICE_WAKE_FAILED')
    expect((error as Error).message).toContain('"laptop" (device:dev-c) is your cloud computer and could not be woken (积分已用完); nothing was sent there')
    expect(call).not.toHaveBeenCalled()
  })

  it('an offline machine that is not the cloud computer is still refused as offline', async () => {
    const { xm, call } = makeCrossMachine(undefined, { wakeCloudComputer: async () => false })
    const error = await xm.call('dev-c', CALLER, { action: 'spawn', prompt: 'x' }).catch((e: unknown) => e)
    expect((error as CrossMachineError).code).toBe('SESSION_DEVICE_OFFLINE')
    expect(call).not.toHaveBeenCalled()
  })

  it('session_devices marks the cloud computer and whether it is asleep', async () => {
    const { xm } = makeCrossMachine(undefined, {
      cloudComputerState: async () => ({ state: 'asleep', deviceId: 'dev-c', error: null, since: null }),
    })
    const rows = await xm.listDeviceRows()
    expect(rows.find((row) => row.device_id === 'dev-c')).toMatchObject({ online: false, cloud_computer: 'asleep' })
    expect(rows.find((row) => row.device_id === 'dev-b')).not.toHaveProperty('cloud_computer')
  })

  it('wakes a paused cloud computer even when the device row still says online', async () => {
    const order: string[] = []
    const wakeCloudComputer = vi.fn(async () => { order.push('wake'); return true })
    const { xm, call } = makeCrossMachine(async () => { order.push('deliver'); return { result: { ok: true } } }, {
      listDevices: async () => [device('dev-a', 'this box', true), device('dev-c', 'cloud', true)],
      cloudComputerState: async () => ({ state: 'asleep', deviceId: 'dev-c', error: null, since: null }),
      wakeCloudComputer,
    })
    await xm.call('dev-c', CALLER, { action: 'message', session_ids: ['assistant'], text: 'result' })
    expect(wakeCloudComputer).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledOnce()
    expect(order).toEqual(['wake', 'deliver'])
  })

  it('session_devices still lists machines when the manager cannot be reached', async () => {
    const { xm } = makeCrossMachine(undefined, { cloudComputerState: async () => { throw new Error('down') } })
    expect((await xm.listDeviceRows()).map((row) => row.device_id)).toEqual(['dev-a', 'dev-b', 'dev-c'])
  })
})


it('prepares a dormant work seat only through the dedicated capability and never falls back to old spawn', async () => {
  const { xm, call } = makeCrossMachine(async (_device, channel) => channel === 'assistantWork.prepare'
    ? { error: { code: 'unknown_method', message: 'No handler registered for assistantWork.prepare' } } : { result: { started: true } })
  await expect(xm.runOnDevice('dev-b', CALLER, { action: 'spawn', assistant_work: { version: 1 }, prompt: 'task' })).rejects.toMatchObject({ code: 'SESSION_DEVICE_OUTDATED' })
  expect(call).toHaveBeenCalledOnce()
  expect(call.mock.calls[0]?.[1]).toBe('assistantWork.prepare')
})

// owner 10-28:一台机器的会话列表只问一处(sessionsOn),几秒内复用,正在问的合成一个,失败不留;往那台发了别的就作废。
describe('one machine\'s session list, asked once and reused for a few seconds', () => {
  const listing = (sessions: unknown[]) => async (_deviceId: string, type: string) =>
    type === 'sessionTimeline.sessionsList' ? { result: { projects: [], sessions } } : { result: { ok: true, value: {} } }
  const lists = (call: ReturnType<typeof vi.fn>) => call.mock.calls.filter(([, type]) => type === 'sessionTimeline.sessionsList').length
  const agentRow = { conversationId: 's-b', projectId: 'pb', agent: { userId: 'agent-b' } }

  it('the agent lookup and the family read share one answer; after five seconds it is asked again', async () => {
    let at = NOW
    const { xm, call } = makeCrossMachine(listing([agentRow]), { now: () => at })
    await xm.sessionsElsewhere(null)
    expect(await xm.messageDeps(async () => CALLER).sessionsOfAgents('dev-b', ['agent-b'])).toEqual(new Map([['agent-b', 's-b']]))
    expect((await xm.sessionsElsewhere(null)).sessions[0]).toMatchObject({ listsAgents: true })
    expect(lists(call)).toBe(1)
    at += 5_000
    await xm.sessionsElsewhere(null)
    expect(lists(call)).toBe(2)
  })

  it('asks once for reads that overlap, and keeps no failure', async () => {
    let fail = true
    const { xm, call } = makeCrossMachine(async (deviceId, type) => {
      if (fail) throw new DeviceRpcTimeoutError('no reply')
      return listing([agentRow])(deviceId, type)
    })
    const [one, two] = await Promise.all([xm.sessionsElsewhere(null), xm.sessionsElsewhere(null)])
    for (const { unreached } of [one, two]) expect(unreached.map((m) => m.deviceId)).toContain('dev-b')
    expect(lists(call)).toBe(1)
    fail = false
    expect((await xm.sessionsElsewhere(null)).sessions).toHaveLength(1)
    expect(lists(call)).toBe(2)
  })

  it('asks again when told to (fresh), or after this machine sent that one anything else', async () => {
    const { xm, call } = makeCrossMachine(listing([agentRow]))
    await xm.sessionsElsewhere(null)
    await xm.sessionsElsewhere(null, { fresh: true })
    expect(lists(call)).toBe(2)
    await xm.sessionsElsewhere(null)
    expect(lists(call)).toBe(2)
    await xm.archiveOn('dev-b', 's-b')
    await xm.sessionsElsewhere(null)
    expect(lists(call)).toBe(3)
  })
})

describe('an agent\'s session on another machine, for opening it', () => {
  const rows = [{ conversationId: 's-b', projectId: 'pb', agent: { userId: 'agent-b' } }]
  it('finds the machine from the roster and the session in that machine\'s list; an agent here is not looked for there', async () => {
    const { xm, call } = makeCrossMachine(async () => ({ result: { projects: [], sessions: rows } }), {
      lookupAgents: async ({ userIds }) => userIds.map((userId) => ({ userId, deviceId: userId === 'agent-a' ? 'dev-a' : 'dev-b', guguNumber: null })),
    })
    expect(await xm.sessionOfAgent('agent-b')).toEqual({ sessionId: 's-b', deviceId: 'dev-b' })
    expect(await xm.sessionOfAgent('agent-a')).toBeNull()
    expect(await xm.sessionOfAgent('agent-x', 'dev-b')).toBeNull()
    // The second lookup reuses that machine's list asked a moment ago (sessionsOn, a few seconds).
    expect(call.mock.calls.map(([deviceId, type]) => [deviceId, type])).toEqual([['dev-b', 'sessionTimeline.sessionsList']])
  })
})
