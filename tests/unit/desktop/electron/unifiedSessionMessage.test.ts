/**
 * delivery-routing:`session_message` 的寻址。收件人一律是一条会话:身份写法(`aid:` / `user:` / `gugu:`)在解析阶段换成它
 * 那条会话,然后与 `session:` 走同一条投递(编排层的 message 动作,这里是假的 graphMessage / remote.deliver)。
 *
 * 可见域:寻址收敛点 `handleUnifiedSessionMessage`(假 deps,不经宿主)。判的是这一层的裁决:自指(两种写法都按会话判)、
 * 已删除 / 未映射 / 不是自己的 agent / 机器离线都在任何投递之前整单拒绝、错误原样回显调用者写的地址、身份写法的结果
 * 照旧按 Agent ID 回报。宿主把分叉的 context 改写成来源会话这件事在 main.ts 的接线里,不在本文件的可见域内。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  handleUnifiedSessionMessage,
  type UnifiedSessionMessageDeps,
} from '../../../../apps/desktop/electron/unified-session-message'

const SELF = '86eb33e1-2d07-4989-9941-69841d00fd6b'
const OTHER = 'ed2c760a-4a7d-4147-bc7e-57ff1673390e'
const SELF_SESSION = '04e58c1d-2222-4222-8222-222222222222'
const OTHER_SESSION = 'd5a9dac5-3333-4333-8333-333333333333'
/** 本机名录:OTHER 这个 agent 的会话。 */
const OTHER_AGENT_SESSION = 'c4c4c4c4-7777-4777-8777-777777777777'
const SELF_NUMBER = 108437
const GONE = 'b3b3b3b3-8888-4888-8888-888888888888'

function makeDeps(overrides: Partial<UnifiedSessionMessageDeps> = {}) {
  const graphMessage = vi.fn(async (sessionIds: string[]) => ({
    recipients: sessionIds.map((id) => ({ to: `session:${id}`, status: 'delivered' as const, message_id: `m-${id}` })),
  }))
  const roster = new Map([[SELF, SELF_SESSION], [OTHER, OTHER_AGENT_SESSION]])
  const localSessionsOfAgents = vi.fn(async (userIds: string[]) => ({
    sessions: new Map(userIds.flatMap((id) => (roster.has(id) ? [[id, roster.get(id)!] as const] : []))),
    deletedRecipients: userIds.filter((id) => id === GONE).map((userId) => ({ userId, name: 'Codex 9' })),
  }))
  const deps: UnifiedSessionMessageDeps = {
    graphMessage,
    caller: { sessionId: SELF_SESSION, runtimeFork: false },
    localSessionsOfAgents,
    resolveLocalGuguNumbers: async (numbers) => new Map(numbers.filter((n) => n === SELF_NUMBER).map((n) => [n, SELF])),
    ...overrides,
  }
  return { deps, graphMessage, localSessionsOfAgents }
}

describe('session_message 的收件人不含调用者自己', () => {
  it('rejects an identity address that resolves to the caller\'s own session and delivers nothing', async () => {
    const { deps, graphMessage } = makeDeps()

    await expect(handleUnifiedSessionMessage({ to: [`aid:${SELF}`], text: 'my lucky number is 7' }, deps))
      .rejects.toThrow(/cannot message itself/)
    expect(graphMessage).not.toHaveBeenCalled()
  })

  it('echoes the address exactly as the caller wrote it, whichever spelling that was', async () => {
    const { deps } = makeDeps()

    for (const entry of [`aid:${SELF}`, `user:${SELF}`]) {
      const error = await handleUnifiedSessionMessage({ to: [entry], text: 'x' }, deps).catch((e: Error) => e.message)
      expect(error).toContain(`session_message: "${entry}" addresses this session itself`)
      // 写法里已经带着 id ⇒ 不再附一遍,也不借机教另一种前缀
      expect(error).not.toContain('(Agent ID')
    }
  })

  it('resolves a gugu: alias before judging, and shows the Agent ID it resolved to', async () => {
    const { deps, graphMessage } = makeDeps()

    await expect(handleUnifiedSessionMessage({ to: [`gugu:${SELF_NUMBER}`], text: 'x' }, deps))
      .rejects.toThrow(`"gugu:${SELF_NUMBER}" (Agent ID ${SELF}) addresses this session itself`)
    expect(graphMessage).not.toHaveBeenCalled()
  })

  it('rejects a session: address that is the caller with the same guided error, and reads no roster for it', async () => {
    const { deps, graphMessage, localSessionsOfAgents } = makeDeps()

    const error = await handleUnifiedSessionMessage({ to: [`session:${SELF_SESSION}`], text: 'x' }, deps)
      .catch((e: Error) => e.message)

    expect(error).toContain(`"session:${SELF_SESSION}" addresses this session itself`)
    expect(error).toMatch(/session_peers.*message_send/s)
    expect(graphMessage).not.toHaveBeenCalled()
    expect(localSessionsOfAgents).not.toHaveBeenCalled()
  })

  it('rejects the whole call when the caller hides among other recipients — nobody is told', async () => {
    const { deps, graphMessage } = makeDeps()

    const error = await handleUnifiedSessionMessage(
      { to: [`aid:${OTHER}`, `session:${OTHER_SESSION}`, `session:${SELF_SESSION}`, `aid:${SELF}`], text: 'x' },
      deps,
    ).catch((e: Error) => e.message)

    expect(error).toContain(`"session:${SELF_SESSION}", "aid:${SELF}" address this session itself`)
    expect(graphMessage).not.toHaveBeenCalled()
  })

  // 运行时分叉(侧边聊天)以来源会话的会话 id 发起 session 动作 ⇒ 它对来源的寻址就是自指。
  // 分叉的 IM 工具(session_peers / message_send)一律不执行,所以普通那句指路对它是假话。
  it('tells a runtime fork something it can act on, not tools it is refused', async () => {
    const asFork = makeDeps({ caller: { sessionId: SELF_SESSION, runtimeFork: true } })
    const asSession = makeDeps()

    const forkError = await handleUnifiedSessionMessage({ to: [`aid:${SELF}`], text: 'note to my source' }, asFork.deps)
      .catch((e: Error) => e.message)
    const sessionError = await handleUnifiedSessionMessage({ to: [`aid:${SELF}`], text: 'x' }, asSession.deps)
      .catch((e: Error) => e.message)

    expect(forkError).toContain('cannot message itself')
    expect(forkError).toContain('side chat')
    expect(forkError).not.toMatch(/session_peers|message_send/)
    expect(sessionError).toMatch(/session_peers.*message_send/s)
    expect(sessionError).not.toContain('side chat')
    expect(asFork.graphMessage).not.toHaveBeenCalled()
  })
})

describe('身份写法与 session: 走同一条投递', () => {
  it('an Agent ID is its session: delivered by the same message action, reported back by the Agent ID', async () => {
    const { deps, graphMessage } = makeDeps()

    const result = await handleUnifiedSessionMessage({ to: [`aid:${OTHER}`, `session:${OTHER_SESSION}`], text: 'hello' }, deps)

    expect(graphMessage).toHaveBeenCalledTimes(1)
    expect(graphMessage).toHaveBeenCalledWith([OTHER_SESSION, OTHER_AGENT_SESSION], 'hello', {})
    expect(result.recipients).toEqual([
      { to: `session:${OTHER_SESSION}`, status: 'delivered', message_id: `m-${OTHER_SESSION}` },
      { to: `user:${OTHER}`, session_id: OTHER_AGENT_SESSION, status: 'delivered', message_id: `m-${OTHER_AGENT_SESSION}` },
    ])
  })

  it('the same session named both ways is told once', async () => {
    const { deps, graphMessage } = makeDeps()

    const result = await handleUnifiedSessionMessage({ to: [`session:${OTHER_AGENT_SESSION}`, `aid:${OTHER}`], text: 'x' }, deps)

    expect(graphMessage).toHaveBeenCalledWith([OTHER_AGENT_SESSION], 'x', {})
    expect(result.recipients).toHaveLength(1)
  })

  it('a deleted agent and an agent with no session here fail loud, before anything is delivered', async () => {
    const { deps, graphMessage } = makeDeps()

    await expect(handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, `aid:${GONE}`], text: 'x' }, deps))
      .rejects.toThrow(`recipient user:${GONE} ("Codex 9") has been deleted`)
    await expect(handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, 'aid:a1a1a1a1-9999-4999-8999-999999999999'], text: 'x' }, deps))
      .rejects.toThrow('is not a session of yours on this machine')
    expect(graphMessage).not.toHaveBeenCalled()
  })
})

/**
 * agent 的 session_* 跨机器(owner 2026-09-30 拍板):本机没有的地址去这个账号的别的机器。身份写法问那台机器的会话列表
 * 换成会话,交过去的一律是会话。找不到 / 不是自己的 agent / 机器离线,都在任何投递之前整单拒绝;已经有人收到之后远端失败
 * 不抛,记成那几个收件人失败。
 */
describe('session_message reaches your sessions on your other machines', () => {
  const REMOTE_SESSION = 'e0e0e0e0-4444-4444-8444-444444444444'
  const REMOTE_AGENT = 'f1f1f1f1-5555-4555-8555-555555555555'
  const REMOTE_AGENT_SESSION = 'f2f2f2f2-5555-4555-8555-555555555555'
  const STRANGER = 'a2a2a2a2-6666-4666-8666-666666666666'

  function withRemote(overrides: Partial<NonNullable<UnifiedSessionMessageDeps['remote']>> = {}, local: string[] = [OTHER_SESSION]) {
    const deliver = vi.fn(async (deviceId: string, group: { sessionIds: string[] }) =>
      group.sessionIds.map((id) => ({ to: `session:${id}`, status: 'delivered' as const, message_id: `m-${deviceId}` })))
    const assertReachable = vi.fn(async () => undefined)
    const sessionsOfAgents = vi.fn(async (_deviceId: string, userIds: string[]) =>
      new Map(userIds.filter((id) => id === REMOTE_AGENT).map((id) => [id, REMOTE_AGENT_SESSION])))
    const remote: NonNullable<UnifiedSessionMessageDeps['remote']> = {
      locateSessions: async (ids) => ({
        found: new Map(ids.filter((id) => id === REMOTE_SESSION).map((id) => [id, 'dev-b'])),
        missingMessage: ids.some((id) => id !== REMOTE_SESSION) ? 'session:ghost is not a session on this machine or on any of this account\'s online machines' : null,
      }),
      locateAgents: async ({ userIds, numbers }) => ({
        byUserId: new Map(userIds.filter((id) => id === REMOTE_AGENT || id === 'c0c0c0c0-1111-4111-8111-111111111111').map((id) => [id, 'dev-b'] as [string, string | null])),
        numberToUserId: new Map(numbers.filter((n) => n === 777).map((n) => [n, REMOTE_AGENT])),
      }),
      thisDeviceId: async () => 'dev-a',
      sessionsOfAgents,
      assertReachable,
      deliver,
      ...overrides,
    }
    const made = makeDeps({ localSessionIds: async (ids) => ids.filter((id) => local.includes(id)), remote })
    return { ...made, deliver, assertReachable, sessionsOfAgents }
  }

  it('hands a session that is not on this machine to the machine it is on, and keeps the local one local', async () => {
    const { deps, graphMessage, deliver, assertReachable } = withRemote()

    const result = await handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, `session:${REMOTE_SESSION}`], text: 'hi' }, deps)

    expect(graphMessage).toHaveBeenCalledWith([OTHER_SESSION], 'hi', {})
    expect(assertReachable).toHaveBeenCalledWith(['dev-b'])
    expect(deliver).toHaveBeenCalledWith('dev-b', { sessionIds: [REMOTE_SESSION], text: 'hi', said: {} })
    expect(result.recipients).toEqual([
      expect.objectContaining({ to: `session:${OTHER_SESSION}`, status: 'delivered' }),
      expect.objectContaining({ to: `session:${REMOTE_SESSION}`, status: 'delivered' }),
    ])
  })

  // owner 10-17:发信方说的发完以后去向与回的是哪条,本机这条腿和别的机器那条腿都原样带到(取值由收件那台机器判)。
  it('carries then / reply_to_message_id to both the local leg and the other machine', async () => {
    const { deps, graphMessage, deliver } = withRemote()
    const said = { source_link: 'gugu-chat://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/11111111-2222-4333-8444-555555555555', then: 'stop', reply_to_message_id: 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f' }

    await handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, `session:${REMOTE_SESSION}`], text: 'done', ...said }, deps)

    expect(graphMessage).toHaveBeenCalledWith([OTHER_SESSION], 'done', said)
    expect(deliver).toHaveBeenCalledWith('dev-b', { sessionIds: [REMOTE_SESSION], text: 'done', said })
  })

  it('an Agent ID / 咕咕号 on another machine is asked of that machine\'s session list, then sent as its session', async () => {
    const { deps, deliver, graphMessage, sessionsOfAgents } = withRemote()

    const result = await handleUnifiedSessionMessage({ to: [`aid:${REMOTE_AGENT}`, 'gugu:777', `aid:${OTHER}`], text: 'hi' }, deps)

    expect(graphMessage).toHaveBeenCalledWith([OTHER_AGENT_SESSION], 'hi', {})
    expect(sessionsOfAgents).toHaveBeenCalledWith('dev-b', [REMOTE_AGENT])
    expect(deliver).toHaveBeenCalledWith('dev-b', { sessionIds: [REMOTE_AGENT_SESSION], text: 'hi', said: {} })
    expect(result.recipients.map((entry) => entry.to)).toEqual([`user:${OTHER}`, `user:${REMOTE_AGENT}`])
  })

  it('an agent that machine does not list fails loud before anything is delivered', async () => {
    const { deps, graphMessage, deliver } = withRemote()

    await expect(handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, 'aid:c0c0c0c0-1111-4111-8111-111111111111'], text: 'x' }, deps))
      .rejects.toThrow('user:c0c0c0c0-1111-4111-8111-111111111111 is not a session of yours on any of your machines')
    expect(graphMessage).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('refuses a session that is nowhere before anything is delivered, even the local ones', async () => {
    const { deps, graphMessage, deliver } = withRemote()

    await expect(handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, 'session:ghost'], text: 'x' }, deps))
      .rejects.toThrow('session_message: session:ghost is not a session on this machine or on any of this account\'s online machines')
    expect(graphMessage).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('refuses someone else\'s agent and points at the chat', async () => {
    const { deps, graphMessage, deliver } = withRemote()

    await expect(handleUnifiedSessionMessage({ to: [`aid:${OTHER}`, `aid:${STRANGER}`], text: 'x' }, deps))
      .rejects.toThrow(`user:${STRANGER} is not one of your agents`)
    expect(graphMessage).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('refuses a whole call to an offline machine before delivering anywhere', async () => {
    const { deps, graphMessage, deliver } = withRemote({
      assertReachable: async () => { throw new Error('"gpu server" (device:dev-b) is offline (last seen 3 h ago); nothing was sent there') },
    })

    await expect(handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, `session:${REMOTE_SESSION}`], text: 'x' }, deps))
      .rejects.toThrow('is offline')
    expect(graphMessage).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('keeps what was delivered when the other machine fails afterwards, and marks its recipients failed with its code', async () => {
    const failure = Object.assign(new Error('no answer'), { code: 'SESSION_DEVICE_NO_ANSWER' })
    const { deps } = withRemote({ deliver: async () => { throw failure } })

    const result = await handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`, `session:${REMOTE_SESSION}`], text: 'x' }, deps)

    expect(result.recipients).toEqual([
      expect.objectContaining({ to: `session:${OTHER_SESSION}`, status: 'delivered' }),
      { to: `session:${REMOTE_SESSION}`, status: 'failed', error: { code: 'SESSION_DEVICE_NO_ANSWER', message: 'no answer' } },
    ])
  })

  it('an agent that runs on this machine but is not on its roster is still "not here", not a remote hop', async () => {
    const { deps, deliver } = withRemote({
      locateAgents: async ({ userIds }) => ({ byUserId: new Map(userIds.map((id) => [id, 'dev-a'] as [string, string | null])), numberToUserId: new Map() }),
    })

    await expect(handleUnifiedSessionMessage({ to: [`aid:${REMOTE_AGENT}`], text: 'x' }, deps))
      .rejects.toThrow('is not a session of yours on any of your machines')
    expect(deliver).not.toHaveBeenCalled()
  })
})


it('preflights every recipient before uploading files, then passes only immutable references to delivery', async () => {
  const prepareFiles = vi.fn(async () => [{ attachment_id: '11111111-1111-4111-8111-111111111111', file_name: 'original.bin', sha256: 'ab'.repeat(32), size_bytes: 4, content_type: 'application/octet-stream' }])
  const { deps, graphMessage } = makeDeps({ prepareFiles })
  await expect(handleUnifiedSessionMessage({to:[`session:${OTHER_SESSION}`,'bare-invalid'],text:'report',files:[{file_path:'/original'}]},deps)).rejects.toThrow()
  expect(prepareFiles).not.toHaveBeenCalled()
  await handleUnifiedSessionMessage({to:[`session:${OTHER_SESSION}`],text:'report',files:[{file_path:'/original'}]},deps)
  expect(prepareFiles).toHaveBeenCalledWith([{file_path:'/original'}],[{sessionId:OTHER_SESSION}])
  expect(graphMessage).toHaveBeenCalledWith([OTHER_SESSION],'report',expect.objectContaining({attachments:await prepareFiles.mock.results[0].value}))
})


describe('durable assistant work admission precedes reachability', () => {
  it('reads the actual addressed task title before committing a new work', async () => {
    const intent = { version: 1, assistant_id: SELF, work_id: OTHER, operation_id: SELF, message_id: OTHER, child_session_id: OTHER_SESSION, coordinator: { session_id: SELF_SESSION, device_id: 'here' }, title: '任务', continuation: false }
    const enqueueWork = vi.fn(async () => ({ route: 'session-direct' as const, recipients: [] }))
    const workTitle = vi.fn(async () => '复测回复「收到，测试正文」')
    const f = makeDeps({ enqueueWork, workTitle, localDeviceId: async () => 'here' })
    await handleUnifiedSessionMessage({ to: [`aid:${OTHER}`], text: '请回复', assistant_work: intent }, f.deps)
    expect(workTitle).toHaveBeenCalledWith(intent, [{ sessionId: OTHER_AGENT_SESSION, deviceId: 'here', agentId: OTHER }])
    expect(enqueueWork).toHaveBeenCalledWith({ ...intent, title: '复测回复「收到，测试正文」' }, '请回复', [], expect.any(Array))
    workTitle.mockRejectedValueOnce(new Error('title unavailable'))
    await expect(handleUnifiedSessionMessage({ to: [`aid:${OTHER}`], text: '请回复', assistant_work: intent }, f.deps)).rejects.toThrow('title unavailable')
    expect(enqueueWork).toHaveBeenCalledOnce()
  })

  it('queues a work report without consulting a sleeping coordinator roster', async () => {
    const enqueueReport = vi.fn(async () => ({ route: 'session-direct' as const, recipients: [{ to: `session:${OTHER_SESSION}`, status: 'accepted' as const, message_id: 'stable' }] }))
    const f = makeDeps({ enqueueReport })
    const result = await handleUnifiedSessionMessage({ to: [`session:${OTHER_SESSION}`], text: 'file ready', work_result: { work_id: SELF, status: 'completed' } }, f.deps)
    expect(result.recipients[0]?.status).toBe('accepted')
    expect(enqueueReport).toHaveBeenCalledOnce()
    expect(f.graphMessage).not.toHaveBeenCalled()
    expect(f.localSessionsOfAgents).not.toHaveBeenCalled()
  })
  it('keeps the host dispatch intent and commits before live delivery', async () => {
    const intent = { version: 1, assistant_id: SELF, work_id: OTHER, operation_id: SELF, message_id: OTHER, child_session_id: OTHER_SESSION, coordinator: { session_id: SELF_SESSION, device_id: 'here' }, title: 'task', continuation: true }
    const enqueueWork = vi.fn(async () => ({ route: 'session-direct' as const, recipients: [{ to: `session:${OTHER_AGENT_SESSION}`, status: 'accepted' as const }] }))
    const f = makeDeps({ enqueueWork, localDeviceId: async () => 'here' })
    await handleUnifiedSessionMessage({ to: [`aid:${OTHER}`], text: 'continue', assistant_work: intent }, f.deps)
    expect(enqueueWork).toHaveBeenCalledWith(intent, 'continue', [], [{ sessionId: OTHER_AGENT_SESSION, deviceId: 'here', agentId: OTHER }])
    expect(f.graphMessage).not.toHaveBeenCalled()
  })
})
