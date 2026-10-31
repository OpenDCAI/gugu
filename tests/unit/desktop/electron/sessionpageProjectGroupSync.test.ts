import { archiveAgentRecord, agentsForOwner } from '@gugu/core/local/state/agentOwner'
import { SessionBootTasks } from '../../../../packages/core/src/shared/sessionBootTasks'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAgentNameSerialsViaSupabase } from '@gugu/core/cloud/agentIdentityReconcile'
import { awaitPending } from '../../../support/awaitFact'
vi.mock('@gugu/core/cloud/agentIdentityReconcile', () => ({
  // #6396 服务端账本(identity.agent_name_serials):登录时与账号的 agent 有变动时 refreshAgentNamingFacts 读它。
  listAgentNameSerialsViaSupabase: vi.fn(async () => serverSerials),
}))
const SUT = '../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning'
const REAPER = '../../../../apps/desktop/electron/sessionpage/sessionpage-agent-reaper'
const IMPLICIT_PROJECT = '00000000-0000-4000-8000-000000000001'
interface RosterRec {
  status?: string
  id: string
  name: string
  agent_type: string
  gugu_user_id: string
  cache?: Record<string, unknown> | null
}
const roster: RosterRec[] = []
const groups: Array<{ chatId: string; name: string; members: string[]; status?: 'active' | 'archived' }> = []
const chatUpdates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = []
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
const dms: Array<{ target: string; chatId: string }> = []
interface Tombstone { gugu_user_id: string; name: string; reaped_at: string; conversation_id?: string }
const tombstones: Tombstone[] = []
const removedRuntimeSessions: string[] = []
let serverSerials = new Map<string, number>()
/** #7341 create_gugu_group 进来的那一刻:返回一个错误就当云端这样答了(模拟预留的 id 撞主键)。 */
let beforeCreateGroup: ((args: Record<string, unknown>) => { error: { code: string; message: string } } | void) | null = null
vi.mock('@gugu/core', () => ({
  recordReapedAgents: vi.fn(async (entries: Tombstone[]) => {
    tombstones.push(...entries)
  }),
  listAgents: vi.fn(async () => roster.map((r) => ({ ...r }))),
  createAgent: vi.fn(async (input: Record<string, unknown>) => {
    const rec: RosterRec = {
      id: `rec-${roster.length + 1}`,
      name: String(input.name),
      agent_type: String(input.agent_type),
      gugu_user_id: String(input.gugu_user_id),
      cache: null,
    }
    roster.push(rec)
    return { ...rec }
  }),
  updateAgent: vi.fn(async (selector: { guguUserId?: string }, patch: Record<string, unknown>) => {
    const rec = roster.find((r) => r.gugu_user_id === selector.guguUserId)
    if (!rec) throw new Error(`updateAgent: no roster record for ${JSON.stringify(selector)}`)
    if (patch.cache) rec.cache = patch.cache as Record<string, unknown>
    if (typeof patch.status === 'string') rec.status = patch.status
    return { ...rec }
  }),
  writeAgentRuntimeSession: vi.fn(async () => undefined),
  archiveAgents: vi.fn(async (match: (rec: RosterRec) => boolean) => {
    const archived = roster.filter((rec) => rec.status !== 'archived' && match(rec))
    archived.forEach(archiveAgentRecord)
    return archived
  }),
  removeAgents: vi.fn(async (match: (rec: RosterRec) => boolean) => {
    const removed = roster.filter(match)
    for (const rec of removed) roster.splice(roster.indexOf(rec), 1)
    return removed
  }),
  removeAgentRuntimeSession: vi.fn(async (agentUserId: string) => {
    removedRuntimeSessions.push(agentUserId)
  }),
  findReapedAgentForSession: vi.fn(async (sessionId: string) =>
    (sessionId ? tombstones.find((t) => t.conversation_id === sessionId) : undefined) ?? null),
}))
vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseUrl: () => 'http://127.0.0.1:55321',
  getSupabaseAnonKey: () => 'anon-public-not-a-secret',
}))
/** 模拟「owner 早先自己开过一条私聊」——@@@no-auto-dm 之后这是私聊唯一的来源。 */
function seedExistingDm(target: string): string {
  const existing = dms.find((d) => d.target === target)
  if (existing) return existing.chatId
  const dm = { target, chatId: `dm-${dms.length + 1}` }
  dms.push(dm)
  return dm.chatId
}
function makeFakeChat() {
  const api = {
    from(table: string) {
      const ctx: {
        id?: string
        patch?: Record<string, unknown>
        userId?: string
        ids?: string[]
        kinds?: string[]
        selected?: boolean
      } = {}
      const rows = (): { data?: unknown; error: null } => {
        if (!ctx.selected || ctx.patch) return { error: null }
        if (table === 'chat_members' && ctx.userId) {
          const userId = ctx.userId
          return {
            data: [
              ...dms.filter((d) => d.target === userId).map((d) => ({ chat_id: d.chatId })),
              ...groups.filter((g) => g.members.includes(userId)).map((g) => ({ chat_id: g.chatId })),
            ],
            error: null,
          }
        }
        if (table === 'chats' && ctx.ids) {
          const wantsDm = !ctx.kinds || ctx.kinds.includes('dm') || ctx.kinds.includes('ai')
          const pool = wantsDm ? dms.map((d) => d.chatId) : groups.map((g) => g.chatId)
          return { data: ctx.ids.filter((id) => pool.includes(id)).map((id) => ({ id })), error: null }
        }
        return { data: [], error: null }
      }
      const chain = {
        insert: async (row: Record<string, unknown>) => {
          if (table === 'chat_members') {
            const g = groups.find((x) => x.chatId === row.chat_id)
            if (g && !g.members.includes(String(row.user_id))) g.members.push(String(row.user_id))
          }
          return { error: null }
        },
        update(patch: Record<string, unknown>) {
          ctx.patch = patch
          return chain
        },
        select: () => {
          ctx.selected = true
          return chain
        },
        eq(col: string, val: string) {
          if (col === 'id') ctx.id = val
          if (col === 'user_id') ctx.userId = val
          if (ctx.patch && table === 'chats' && ctx.id) {
            chatUpdates.push({ table, patch: ctx.patch, id: ctx.id })
            ctx.patch = undefined
          }
          return chain
        },
        in(col: string, values: string[]) {
          if (col === 'id') ctx.ids = values
          if (col === 'kind') ctx.kinds = values
          return chain
        },
        limit: () => chain,
        maybeSingle: async () => {
          if (table === 'chats' && ctx.id) {
            const g = groups.find((x) => x.chatId === ctx.id)
            return { data: g ? { id: g.chatId, status: g.status ?? 'active' } : null, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (v: { data?: unknown; error: null }) => unknown) => resolve(rows()),
      }
      return chain
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      if (name === 'add_group_agent') {
        const group = groups.find((g) => g.chatId === args.p_chat_id)
        if (!group) return { data: null, error: { message: 'not_a_group' } }
        const user = String(args.p_agent_user_id)
        const exists = group.members.includes(user)
        if (!exists) group.members.push(user)
        return { data: { chat_id: group.chatId, status: exists ? 'already_member' : 'joined' }, error: null }
      }
      if (name === 'set_agent_listen_mode_as') return { data: { chat_id: args.p_chat_id, user_id: args.p_agent_user_id, listen_mode: args.p_mode }, error: null }
      if (name === 'archive_group_as') {
        chatUpdates.push({ table: 'chats', id: String(args.p_chat_id), patch: { status: 'archived' } })
        return { data: { chat_id: args.p_chat_id, status: 'archived' }, error: null }
      }
      if (name === 'open_dm') {
        const target = String(args.p_target_user_id)
        let dm = dms.find((d) => d.target === target)
        if (!dm) { dm = { target, chatId: `dm-${dms.length + 1}` }; dms.push(dm) }
        return { data: dm.chatId, error: null }
      }
      if (name === 'create_gugu_group') {
        const hooked = beforeCreateGroup?.(args)
        if (hooked) return hooked
        groups.push({
          chatId: String(args.p_chat_id),
          name: String(args.p_name),
          members: [
            String(args.p_owner_user_id),
            ...((args.p_initial_members as Array<{ user_id: string }>) ?? []).map((m) => m.user_id),
          ],
        })
      }
      return { error: null }
    },
  }
  return api
}
vi.mock('../../../../apps/desktop/electron/supabase', () => ({ makeChatClient: () => makeFakeChat(), electronFetch: undefined }))
const registered: Array<{ guguAgentUserId: string; sessionId: string }> = []
const clearedDeliveryOwners: string[] = []
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-registry', () => ({
  registerEmdashAgent: (reg: { guguAgentUserId: string; sessionId: string }) => {
    registered.push(reg)
  },
  emdashAgentRegistry: { unregister: vi.fn() },
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry', () => ({
  unregisterSessionpageDeliveryOwners: async (guguAgentUserId: string) => {
    clearedDeliveryOwners.push(guguAgentUserId)
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      if (registered[index]?.guguAgentUserId === guguAgentUserId) registered.splice(index, 1)
    }
  },
  prepareSessionpageDeliveryOwner: async (
    ownerKind: 'emdash' | 'native' | 'none',
    registration: { guguAgentUserId: string; sessionId: string },
  ) => {
    clearedDeliveryOwners.push(registration.guguAgentUserId)
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      if (registered[index]?.guguAgentUserId === registration.guguAgentUserId) registered.splice(index, 1)
    }
    if (ownerKind !== 'none') registered.push(registration)
  },
}))
let home = ''
/**
 * identity.provision_taskpage_agent 的假服务端:收下客户端预生成的 agent id;有群名时按映射里那个群的状态
 * 二选一 —— 在且活着 ⇒ 加座位;归档了 ⇒ 用新 id 另建;不存在 ⇒ 就用映射里那个 id 建。
 */
async function fakeProvisionOneTrip(input: {
  agentId: string
  displayName: string
  groupName?: string | null
  priorGroupChatId?: string | null
  newGroupChatId?: string | null
}) {
  if (!input.groupName || !input.priorGroupChatId) {
    return { agentId: input.agentId, displayName: input.displayName, groupChatId: '', groupCreated: false, priorGroupState: 'none' }
  }
  const prior = groups.find((g) => g.chatId === input.priorGroupChatId)
  if (prior && prior.status !== 'archived') {
    prior.members.push(input.agentId)
    return { agentId: input.agentId, displayName: input.displayName, groupChatId: prior.chatId, groupCreated: false, priorGroupState: 'active' }
  }
  // 当前供给走 one-trip RPC；同一份冲突注入也必须进入这条测试服务端路径。
  const collision = !prior ? beforeCreateGroup?.({ p_chat_id: input.priorGroupChatId }) : undefined
  if (collision) {
    if (collision.error.code !== '23505') throw new Error(collision.error.message)
    const raced = groups.find((g) => g.chatId === input.priorGroupChatId)
    if (raced) {
      raced.members.push(input.agentId)
      return { agentId: input.agentId, displayName: input.displayName, groupChatId: raced.chatId, groupCreated: false, priorGroupState: 'active' }
    }
    // 服务端能看见但当前账号不在其中的群，按 foreign 返回一个新群；客户端须回写映射。
    const chatId = String(input.newGroupChatId)
    groups.push({ chatId, name: input.groupName, members: ['owner-1', input.agentId] })
    return { agentId: input.agentId, displayName: input.displayName, groupChatId: chatId, groupCreated: true, priorGroupState: 'foreign' }
  }
  const chatId = prior ? String(input.newGroupChatId) : input.priorGroupChatId
  groups.push({ chatId, name: input.groupName, members: ['owner-1', input.agentId] })
  return { agentId: input.agentId, displayName: input.displayName, groupChatId: chatId, groupCreated: true, priorGroupState: prior ? 'archived' : 'missing' }
}
const deps = {
  getAuth: async () => ({ accessToken: 'token', refreshToken: 'refresh', userId: 'owner-1' }),
  resolveDeviceId: async () => 'device-1',
  provisionOneTrip: fakeProvisionOneTrip,
  resolveProjectName: async (projectId: string) =>
    ({ 'proj-alpha': '阿尔法项目', 'proj-beta': '贝塔项目' })[projectId] ?? null,
  get env(): NodeJS.ProcessEnv {
    return { GUGU_HOME: home } as NodeJS.ProcessEnv
  },
}
/** 公网那一发在会话起来之后才跑:读云端那一侧(群、成员)之前等它落地。 */
async function settleCloud(): Promise<void> {
  const { settleSessionpageCloudProvisioning } = await import(SUT)
  await settleSessionpageCloudProvisioning()
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-taskpage-groups-'))
  roster.length = 0
  groups.length = 0
  chatUpdates.length = 0
  rpcCalls.length = 0
  dms.length = 0
  tombstones.length = 0
  removedRuntimeSessions.length = 0
  registered.length = 0
  clearedDeliveryOwners.length = 0
  serverSerials = new Map()
  beforeCreateGroup = null
  vi.clearAllMocks()
  // #6396 本进程发过的号是模块级事实(序号只增不减);每条用例是一个新账号的起点。
  const { resetSessionpageCloudProvisioningForTests } = await import(SUT)
  resetSessionpageCloudProvisioningForTests()
})
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true })
  home = ''
})
describe('spec ⑨ 创建侧:项目=群 / 无项目=私聊 / 序号命名', () => {
  it('replays interrupted creates through the same owner-scoped roster task binding', async () => {
    const { sessionpageAgentSessionForStart, SESSION_CACHE_KEY, OWNER_CACHE_KEY, PARKED_SESSION_CACHE_KEY } = await import(SUT)
    roster.push({ id: 'assistant-record', name: 'Gugu', agent_type: 'claude-code', gugu_user_id: 'assistant',
      cache: { [SESSION_CACHE_KEY]: 'interrupted-task', [OWNER_CACHE_KEY]: 'owner-1' } })
    expect(await sessionpageAgentSessionForStart('assistant', 'owner-1')).toBe('interrupted-task')
    expect(await sessionpageAgentSessionForStart('assistant', 'owner-1')).toBe('interrupted-task')
    await expect(sessionpageAgentSessionForStart('assistant', 'other-owner')).rejects.toThrow('owner mismatch')
    expect(await sessionpageAgentSessionForStart('new-agent', 'owner-1')).toBeUndefined()
    expect(roster).toHaveLength(1)
    expect(roster[0]!.cache![SESSION_CACHE_KEY]).toBe('interrupted-task')
    delete roster[0]!.cache![SESSION_CACHE_KEY]
    roster[0]!.cache![PARKED_SESSION_CACHE_KEY] = 'interrupted-task'
    expect(await sessionpageAgentSessionForStart('assistant', 'owner-1')).toBe('interrupted-task')
  })
  it('同一项目的两个会话 → 同一个群,群名 = 项目名', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const a = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const b = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: 'proj-alpha' }, deps)
    await settleCloud()
    expect(groups, '一项目一群:只建了一个群').toHaveLength(1)
    expect(groups[0].name, '群名 = 项目名').toBe('阿尔法项目')
    expect(groups[0].members, '群里有 owner + 两个 agent').toEqual(
      expect.arrayContaining(['owner-1', a!.guguAgentUserId, b!.guguAgentUserId]))
  })
  it('不同项目 → 不同的群(❌ 全局共享的兜底大群)', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: 'proj-beta' }, deps)
    await settleCloud()
    expect(groups.map((g) => g.name).sort()).toEqual(['贝塔项目', '阿尔法项目'].sort())
    expect(new Set(groups.map((g) => g.chatId)).size).toBe(2)
  })
  it('@@@no-auto-dm 无项目的会话 → 既不建群,也不建私聊', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const solo = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-solo', providerId: 'codex', surface: 'tui', cwd: '/w/solo', projectId: '' }, deps)
    await settleCloud()
    expect(solo?.chatId, '没开过私聊 ⇒ 没有锚,这是合法状态').toBe('')
    expect(groups, '不建群').toHaveLength(0)
    expect(rpcCalls.some((c) => c.name === 'create_gugu_group'), '没调建群 RPC').toBe(false)
    expect(rpcCalls.some((c) => c.name === 'open_dm'), '❌ 一次 open_dm 都不许调 —— 那是 find-or-create,会建').toBe(false)
    expect(dms, '库里不该多出私聊').toHaveLength(0)
  })
  it('聊天页首轮显式请求地址时 → 幂等 open_dm 并回写 roster cache', async () => {
    const { openOwnerDirectChatForAgent } = await import(SUT)
    roster.push({
      id: 'rec-chat-first', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'chat-first-agent',
      cache: { emdash_session_id: 'conv-chat-first', sessionpage_direct_chat_id: '' },
    })
    const first = await openOwnerDirectChatForAgent('chat-first-agent', 'token', deps.env)
    const second = await openOwnerDirectChatForAgent('chat-first-agent', 'token', deps.env)
    expect(first).toBe('dm-1')
    expect(second).toBe(first)
    expect(rpcCalls.filter((call) => call.name === 'open_dm')).toHaveLength(2)
    expect((roster[0].cache as Record<string, string>).sessionpage_direct_chat_id).toBe(first)
  })
  it('@@@no-auto-dm 隐式 task-home 项目同样不建私聊', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const solo = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-implicit', providerId: 'codex', surface: 'tui', cwd: '/w/x', projectId: IMPLICIT_PROJECT }, deps)
    expect(solo?.chatId).toBe('')
    expect(groups).toHaveLength(0)
    expect(dms).toHaveLength(0)
  })
  it('@@@no-auto-dm 有项目的会话:群照建,私聊照样不建', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-p', providerId: 'codex', surface: 'tui', cwd: '/w/p', projectId: 'proj-alpha' }, deps)
    await settleCloud()
    expect(groups, '群照建').toHaveLength(1)
    expect(dms, '私聊不建').toHaveLength(0)
  })
  it('@@@no-auto-dm owner 早先开过私聊 → provision 只查不建,把那一条接回来当锚', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    roster.push({
      id: 'rec-chatted', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'chatted-agent',
      cache: { emdash_session_id: 'conv-chatted', sessionpage_group_chat_id: '', emdash_project_id: '' },
    })
    const opened = seedExistingDm('chatted-agent')
    const { settleSessionpageCloudProvisioning } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-chatted', providerId: 'codex', surface: 'tui', cwd: '/w/c', projectId: '' }, deps)
    await settleSessionpageCloudProvisioning()
    expect(rpcCalls.some((c) => c.name === 'open_dm'), '查到了也不该再调 open_dm').toBe(false)
    expect(dms, '❌ 不许因为这次 provision 多出第二条').toHaveLength(1)
    expect(
      (roster[0].cache as Record<string, string>).sessionpage_direct_chat_id,
      '接回来的锚要写回缓存,下次 resume 直接命中',
    ).toBe(opened)
  })
  it('@@@no-auto-dm 存量 agent(缓存里没有 chat、也从没开过私聊)重开 → 保持无锚,不回填', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    roster.push({
      id: 'rec-legacy', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'legacy-agent',
      cache: { emdash_session_id: 'conv-legacy', sessionpage_group_chat_id: '', emdash_project_id: '' },
    })
    const got = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-legacy', providerId: 'codex', surface: 'tui', cwd: '/w/l', projectId: '' }, deps)
    expect(got?.chatId, '没开过就是没有').toBe('')
    expect(rpcCalls.some((c) => c.name === 'open_dm'), '❌ 不回填').toBe(false)
    expect(dms).toHaveLength(0)
    expect(roster, '不许因此多出第二个身份').toHaveLength(1)
  })
  it('@@@no-auto-dm 缓存里已有 chat 的存量 agent → 直接命中缓存,连查都不查', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    roster.push({
      id: 'rec-warm', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'warm-agent',
      cache: { emdash_session_id: 'conv-warm', sessionpage_group_chat_id: 'chat-existing', emdash_project_id: '' },
    })
    const got = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-warm', providerId: 'codex', surface: 'tui', cwd: '/w/w', projectId: '' }, deps)
    expect(got?.chatId).toBe('chat-existing')
    expect(rpcCalls.some((c) => c.name === 'open_dm'), '缓存命中就不该再开一次').toBe(false)
  })
  it('@@@no-auto-dm 存量项目 agent 缺群 → 补群,但不补私聊', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    roster.push({
      id: 'rec-proj', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'proj-agent',
      cache: { emdash_session_id: 'conv-proj', sessionpage_group_chat_id: '', emdash_project_id: 'proj-x' },
    })
    const { settleSessionpageCloudProvisioning } = await import(SUT)
    const got = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-proj', providerId: 'codex', surface: 'tui', cwd: '/w/p', projectId: 'proj-x' }, deps)
    await settleSessionpageCloudProvisioning()
    expect(groups, '缺群要补 —— 群不是可有可无的锚').toHaveLength(1)
    expect(got?.chatId, '私聊没开过就还是没有').toBe('')
    expect(rpcCalls.some((c) => c.name === 'open_dm'), '项目成员关系不触发建私聊').toBe(false)
  })
  it.each([
    {
      label: 'engine counters',
      entries: [['codex', undefined], ['codex', undefined], ['claude', undefined]],
      expected: ['Codex 1', 'Codex 2', 'Claude 1'],
    },
    {
      // #6396 序号是「用过的最大号 + 1」,不是同类型数量 + 1:「小弟」不占 Codex 的号。
      label: 'explicit then generated',
      entries: [['codex', '小弟'], ['codex', undefined]],
      expected: ['小弟', 'Codex 1'],
    },
    {
      label: 'repeated explicit names',
      entries: [['codex', '小弟'], ['codex', '小弟'], ['codex', '小弟']],
      expected: ['小弟', '小弟 2', '小弟 3'],
    },
    {
      label: 'cross-engine collision',
      entries: [['codex', '小弟'], ['claude', '小弟']],
      expected: ['小弟', '小弟 2'],
    },
  ] as const)('display names stay unique: $label', async ({ entries, expected }) => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    for (const [index, [providerId, displayName]] of entries.entries()) {
      await provisionSessionpageAgentForSession({
        sessionId: `name-${index}`,
        providerId,
        surface: 'tui',
        cwd: '/w',
        projectId: '',
        ...(displayName ? { displayName } : {}),
      }, deps)
    }
    expect(roster.map((r) => r.name)).toEqual(expected)
    expect(new Set(roster.map((r) => r.name)).size).toBe(expected.length)
  })
  it('claude / codex 无论 GUI 还是 TUI,都拿到身份', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    for (const providerId of ['codex', 'claude']) {
      for (const surface of ['acp', 'tui'] as const) {
        const provisioned = await provisionSessionpageAgentForSession(
          {
            sessionId: `conv-${providerId}-${surface}`,
            providerId,
            surface,
            cwd: '/w',
            projectId: '',
          },
          deps,
        )
        expect(provisioned?.guguAgentUserId, `${providerId}/${surface} 必须有身份`).toBeTruthy()
      }
    }
    expect(roster.map((r) => r.name)).toEqual(['Codex 1', 'Codex 2', 'Claude 1', 'Claude 2'])
  })
  it('opencode ACP 会话拿到身份,按引擎序号命名', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const provisioned = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-oc', providerId: 'opencode', surface: 'acp', cwd: '/w', projectId: '' }, deps)
    expect(provisioned?.guguAgentUserId, 'opencode 会话必须有身份').toBeTruthy()
    expect(roster.map((r) => r.name)).toEqual(['OpenCode 1'])
    expect(roster[0]?.agent_type).toBe('opencode')
    expect(registered.map((entry) => entry.sessionId)).toEqual(['conv-oc'])
  })
  it('opencode task-TUI 会话拿到身份(serve/attach 升档 → router+native)', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const provisioned = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-oc-tui', providerId: 'opencode', surface: 'tui', cwd: '/w', projectId: '' }, deps)
    expect(provisioned?.guguAgentUserId, 'opencode TUI 会话必须有身份').toBeTruthy()
    expect(roster.map((r) => r.name)).toEqual(['OpenCode 1'])
    expect(registered).toEqual([
      { guguAgentUserId: provisioned!.guguAgentUserId, sessionId: 'conv-oc-tui' },
    ])
  })
  it('a failed provisioning attempt cannot clear an existing ACP owner', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-switch', providerId: 'kimi', surface: 'acp', cwd: '/w', projectId: '' }, deps)
    expect(registered).toHaveLength(1)
    const clearedBefore = [...clearedDeliveryOwners]
    await expect(provisionSessionpageAgentForSession(
      { sessionId: 'conv-switch', providerId: 'no-such-agent', surface: 'tui', cwd: '/w', projectId: '' }, deps),
    ).rejects.toThrow("Unknown agent plugin 'no-such-agent'")
    expect(clearedDeliveryOwners).toEqual(clearedBefore)
    expect(registered.map((entry) => entry.sessionId)).toEqual(['conv-switch'])
  })
  it('resolves exactly one owner kind per claimant surface without provider-name branches', async () => {
    const { resolveSessionpageDeliveryOwnerKind } = await import(SUT)
    expect([
      ['codex', 'acp', 'emdash'],
      ['claude', 'acp', 'emdash'],
      ['opencode', 'acp', 'emdash'],
      ['codex', 'tui', 'native'],
      ['claude', 'tui', 'native'],
      ['opencode', 'tui', 'native'],
    ].map(([providerId, surface, expected]) => ({
      providerId,
      surface,
      expected,
      actual: resolveSessionpageDeliveryOwnerKind(providerId, surface as 'acp' | 'tui'),
    }))).toEqual([
      { providerId: 'codex', surface: 'acp', expected: 'emdash', actual: 'emdash' },
      { providerId: 'claude', surface: 'acp', expected: 'emdash', actual: 'emdash' },
      { providerId: 'opencode', surface: 'acp', expected: 'emdash', actual: 'emdash' },
      { providerId: 'codex', surface: 'tui', expected: 'native', actual: 'native' },
      { providerId: 'claude', surface: 'tui', expected: 'native', actual: 'native' },
      { providerId: 'opencode', surface: 'tui', expected: 'native', actual: 'native' },
    ])
    expect(() => resolveSessionpageDeliveryOwnerKind('gemini', 'tui')).toThrow(
      "Agent plugin 'gemini' does not declare a tui sessionpage integration",
    )
  })
  it('映射里的群已归档 ⇒ 不复用,另建新群并换掉映射', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-g1', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: 'proj-gamma' }, deps)
    await settleCloud()
    const first = groups.find((g) => g.name && g.members.length)!
    first.status = 'archived'
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-g2', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: 'proj-gamma' }, deps)
    await settleCloud()
    const fresh = groups.find((g) => g.chatId !== first.chatId)!
    expect(fresh, '归档群不复用,得另建一个').toBeTruthy()
    expect(roster.find((r) => r.cache?.emdash_session_id === 'conv-g2')?.cache).toMatchObject({ sessionpage_group_chat_id: fresh.chatId })
    expect(first.members, '新 agent 没被塞进归档群').toHaveLength(2)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-g3', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: 'proj-gamma' }, deps)
    await settleCloud()
    expect(groups.filter((g) => g.chatId !== first.chatId), '第三条会话复用新群,不再建').toHaveLength(1)
    const { settleSessionpageCloudProvisioning } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-g1', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: 'proj-gamma' }, deps)
    await settleSessionpageCloudProvisioning()
    expect(roster.find((r) => r.cache?.emdash_session_id === 'conv-g1')?.cache).toMatchObject({ sessionpage_group_chat_id: fresh.chatId })
    expect(fresh.members, 'conv-g1 的 agent 进了新群').toContain(roster.find((r) => r.cache?.emdash_session_id === 'conv-g1')!.gugu_user_id)
    expect(groups.filter((g) => g.chatId !== first.chatId), '仍只有那一个新群').toHaveLength(1)
  })
  it('reuses a group only for the exact cached project and clears it when projectless', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const alpha = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-move', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: 'proj-alpha' }, deps)
    await settleCloud()
    const alphaGroup = groups[0].chatId
    const { settleSessionpageCloudProvisioning } = await import(SUT)
    const beta = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-move', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: 'proj-beta' }, deps)
    await settleSessionpageCloudProvisioning()
    const betaGroup = groups[1].chatId
    expect(beta?.chatId).toBe(alpha?.chatId)
    expect(betaGroup).not.toBe(alphaGroup)
    expect(roster[0]?.cache).toMatchObject({
      emdash_project_id: 'proj-beta',
      sessionpage_group_chat_id: betaGroup,
    })
    const projectless = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-move', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: '' }, deps)
    expect(projectless?.chatId).toBe(alpha?.chatId)
    expect(roster[0]?.cache).toMatchObject({
      emdash_project_id: '',
      sessionpage_group_chat_id: '',
    })
  })
  it('boot registration excludes archived rows using the shared roster view', async () => {
    const { provisionSessionpageAgentForSession, registerExistingSessionpageAgents } = await import(SUT)
    await provisionSessionpageAgentForSession({ sessionId: 'archived-boot', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: '' }, deps)
    archiveAgentRecord(roster[0])
    expect(await registerExistingSessionpageAgents({ GUGU_HOME: home }, { ownerUserId: 'owner-1' })).toBe(0)
    expect(roster[0].cache?.emdash_session_id).toBe('archived-boot')
  })

  it('boot registers a persisted ACP binding with its session-life claimant (an inbox unit enqueues; nothing waits for live)', async () => {
    const { registerExistingSessionpageAgents } = await import(SUT)
    roster.push(
      {
        id: 'rec-acp', name: 'OpenCode 1', agent_type: 'opencode', gugu_user_id: 'agent-acp',
        cache: {
          emdash_session_id: 'conv-acp', sessionpage_direct_chat_id: 'dm-acp',
          sessionpage_provider_id: 'opencode', sessionpage_session_surface: 'acp',
        },
      },
    )
    await expect(registerExistingSessionpageAgents({ GUGU_HOME: home })).resolves.toBe(1)
    expect(registered).toEqual([{ guguAgentUserId: 'agent-acp', sessionId: 'conv-acp' }])
  })
  it('boot keeps a legacy taskpage binding owned until reopen stamps the exact capability cell', async () => {
    const { registerExistingSessionpageAgents } = await import(SUT)
    roster.push({
      id: 'rec-legacy', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'agent-legacy',
      cache: {
        emdash_session_id: 'conv-legacy',
        emdash_project_id: 'project-legacy',
        sessionpage_group_chat_id: 'group-legacy',
      },
    })
    await expect(registerExistingSessionpageAgents({ GUGU_HOME: home })).resolves.toBe(1)
    expect(registered).toEqual([])
  })
  it('isolates an invalid binding and registers the remaining boot roster', async () => {
    const { registerExistingSessionpageAgents } = await import(SUT)
    const bootTasks = new SessionBootTasks(vi.fn())
    roster.push(
      { id: 'bad', name: 'Bad', agent_type: 'codex', gugu_user_id: 'bad-agent', cache: { emdash_session_id: 'bad-task', sessionpage_provider_id: 'codex' } },
      { id: 'good', name: 'Good', agent_type: 'codex', gugu_user_id: 'good-agent', cache: { emdash_session_id: 'good-task' } },
    )
    await expect(registerExistingSessionpageAgents({ GUGU_HOME: home }, { bootTasks })).resolves.toBe(2)
    expect(bootTasks.snapshot()).toEqual([{ operation: 'roster-rehydrate', taskId: 'bad-task', message: 'Persisted task capability is incomplete' }])
  })
  it('boot maps a partially stamped capability row before failing loud', async () => {
    const { registerExistingSessionpageAgents } = await import(SUT)
    roster.push({
      id: 'rec-partial', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'agent-partial',
      cache: {
        emdash_session_id: 'conv-partial',
        sessionpage_provider_id: 'codex',
      },
    })
    await expect(registerExistingSessionpageAgents({ GUGU_HOME: home })).rejects.toThrow(
      'session-page capability cache is incomplete or invalid for agent record(s): agent-partial',
    )
    expect(registered).toEqual([])
  })
  it('boot maps an invalid stamped surface before failing loud', async () => {
    const { registerExistingSessionpageAgents } = await import(SUT)
    roster.push({
      id: 'rec-invalid', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'agent-invalid',
      cache: {
        emdash_session_id: 'conv-invalid',
        sessionpage_provider_id: 'codex',
        sessionpage_session_surface: 'garbage',
      },
    })
    await expect(registerExistingSessionpageAgents({ GUGU_HOME: home })).rejects.toThrow(
      'session-page capability cache is incomplete or invalid for agent record(s): agent-invalid',
    )
    expect(registered).toEqual([])
  })
  it.each([
    { label: 'unknown provider', providerId: 'not-a-provider', surface: 'acp' },
      { label: 'undeclared provider surface', providerId: 'openclaw', surface: 'acp' },
    { label: 'undeclared Gemini TUI surface', providerId: 'gemini', surface: 'tui' },
  ])('boot maps an $label cell before failing loud', async ({ providerId, surface }) => {
    const { registerExistingSessionpageAgents } = await import(SUT)
    roster.push({
      id: 'rec-unresolved', name: 'Legacy 1', agent_type: 'codex', gugu_user_id: 'agent-unresolved',
      cache: {
        emdash_session_id: 'conv-unresolved',
        sessionpage_provider_id: providerId,
        sessionpage_session_surface: surface,
      },
    })
    await expect(registerExistingSessionpageAgents({ GUGU_HOME: home })).rejects.toThrow(
      'session-page capability cache is incomplete or invalid for agent record(s): agent-unresolved',
    )
    expect(registered).toEqual([])
  })
  it('身份 provisioning 逐 provider/surface 读取 registry 声明', async () => {
    const { canProvisionSessionpageAgent } = await import(SUT)
    for (const engine of ['codex', 'claude']) {
      for (const surface of ['acp', 'tui'] as const) {
        expect(canProvisionSessionpageAgent(engine, surface), `${engine}/${surface} 应能拿身份`).toBe(true)
      }
    }
    expect(canProvisionSessionpageAgent('opencode', 'acp')).toBe(true)
    expect(canProvisionSessionpageAgent('opencode', 'tui')).toBe(true)
    expect(() => canProvisionSessionpageAgent('gemini', 'tui')).toThrow(
      "Agent plugin 'gemini' does not declare a tui sessionpage integration",
    )
    expect(canProvisionSessionpageAgent('pi', 'tui')).toBe(true)
    expect(canProvisionSessionpageAgent('hermes', 'acp')).toBe(true)
    expect(() => canProvisionSessionpageAgent('hermes', 'tui')).toThrow(
      "Agent plugin 'hermes' does not declare a tui sessionpage integration",
    )
  })
  it('droid task-TUI provisions an identity and resolves the host adapter used for delivery', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { resolveSessionTuiHostAdapter } = await import('@gugu/session-plugins/agents')
    expect(resolveSessionTuiHostAdapter('droid')).toBe('droid-daemon-v1')
    const provisioned = await provisionSessionpageAgentForSession(
      { sessionId: 'droid-conv', providerId: 'droid', surface: 'tui', cwd: '/w', projectId: '' },
      deps,
    )
    expect(provisioned?.guguAgentUserId).toBeTruthy()
    expect(roster[0]).toMatchObject({
      gugu_user_id: provisioned!.guguAgentUserId,
      cache: expect.objectContaining({
        emdash_session_id: 'droid-conv',
        sessionpage_session_surface: 'tui',
      }),
    })
    expect(registered).toEqual([])
  })
  it('只有已验证为 addressable 的任务页 provider 才 provision', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    expect(await provisionSessionpageAgentForSession(
      { sessionId: 'c', providerId: 'auggie', surface: 'tui', cwd: '/w', projectId: 'proj-alpha' }, deps)).toMatchObject({
      guguAgentUserId: expect.any(String),
    })
    expect(roster).toHaveLength(1)
    expect(await provisionSessionpageAgentForSession(
      { sessionId: 'pi', providerId: 'pi', surface: 'tui', cwd: '/w', projectId: 'proj-alpha' }, deps)).toMatchObject({
      guguAgentUserId: expect.any(String),
    })
    expect(roster).toHaveLength(2)
  })
  it('provision 落地 → 播出「这条会话已有身份」(含会话 id 与寻址名)', async () => {
    const { provisionSessionpageAgentForSession, onSessionpageAgentProvisioned } = await import(SUT)
    const seen: Array<{ sessionId: string; displayName: string; agentUserId: string }> = []
    const off = onSessionpageAgentProvisioned((e: { sessionId: string; displayName: string; agentUserId: string }) => seen.push(e))
    const p = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-ann', providerId: 'claude', surface: 'tui', cwd: '/w', projectId: '' }, deps)
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0].sessionId, '按会话寻址').toBe('conv-ann')
    expect(seen[0].displayName, '播的名字 = 通讯录里的寻址名').toBe('Claude 1')
    expect(seen[0].agentUserId).toBe(p?.guguAgentUserId)
  })
  it('重开同一会话(幂等复用)也照播 —— 否则重开后入口又是死的', async () => {
    const { provisionSessionpageAgentForSession, onSessionpageAgentProvisioned } = await import(SUT)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-re', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: '' }, deps)
    const seen: Array<{ displayName: string }> = []
    const off = onSessionpageAgentProvisioned((e: { displayName: string }) => seen.push(e))
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-re', providerId: 'codex', surface: 'tui', cwd: '/w', projectId: '' }, deps)
    off()
    expect(roster, '没有第二个身份').toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ displayName: 'Codex 1' })
  })
})
describe('#6396 序号只增不减', () => {
  const provisionFresh = async (sessionId: string, extra: Record<string, unknown> = {}, withDeps: object = deps) => {
    const { provisionSessionpageAgentForSession, settleSessionpageCloudProvisioning } = await import(SUT)
    const got = await provisionSessionpageAgentForSession(
      { sessionId, providerId: 'claude', surface: 'acp', cwd: '/w', projectId: '', ...extra },
      withDeps,
    )
    await settleSessionpageCloudProvisioning()
    return got
  }
  /**
   * 账本(identity.agent_name_serials)的下一次读,读回的是那一刻的 `serverSerials`。refreshAgentNamingFacts
   * 刻意不交回完成信号(它不挡启动链),可等的事实是这次读本身:产品拿到读的那一刻同步挂上 then(落进本机起点),
   * 这里交回的 promise 经由同一次读落定、排在那个 then 之后 —— 等到它,本机起点已经抬上去了。
   * 在调用 refreshAgentNamingFacts **之前**取:读可能由它直接发出,也可能由在途那一发结束后补发。
   */
  const nextLedgerRead = (): Promise<Map<string, number>> => new Promise((resolve) => {
    vi.mocked(listAgentNameSerialsViaSupabase).mockImplementationOnce(() => {
      const read = Promise.resolve(serverSerials)
      resolve(read)
      return read
    })
  })
  it('删过的号不回收:名下只剩 Claude 4 / Claude 28 两个,下一个是 Claude 29(旧规则给 Claude 3)', async () => {
    roster.push(
      { id: 'rec-4', name: 'Claude 4', agent_type: 'claude-code', gugu_user_id: 'a-4', cache: { sessionpage_owner_user_id: 'owner-1' } },
      { id: 'rec-28', name: 'Claude 28', agent_type: 'claude-code', gugu_user_id: 'a-28', cache: { sessionpage_owner_user_id: 'owner-1' } },
      { id: 'rec-renamed', name: '压页数', agent_type: 'claude-code', gugu_user_id: 'a-r', cache: { sessionpage_owner_user_id: 'owner-1' } },
    )
    await provisionFresh('conv-29')
    expect(roster.at(-1)?.name).toBe('Claude 29')
  })
  it('服务端账本比本机名册高(删掉的、别的电脑发的)⇒ 从账本 + 1 起', async () => {
    const { refreshAgentNamingFacts } = await import(SUT)
    serverSerials = new Map([['Claude', 40], ['Codex', 3]])
    roster.push({ id: 'rec-28', name: 'Claude 28', agent_type: 'claude-code', gugu_user_id: 'a-28', cache: { sessionpage_owner_user_id: 'owner-1' } })
    const ledgerLanded = nextLedgerRead()
    refreshAgentNamingFacts({ accessToken: 'token', userId: 'owner-1' })
    await awaitPending('账本读数落进本机起点', ledgerLanded)
    await provisionFresh('conv-next')
    expect(roster.at(-1)?.name).toBe('Claude 41')
  })
  it('另一台设备刚发了号(推送到达)⇒ 本机下一条直接避开,❌ 先用重再被改名', async () => {
    const { refreshAgentNamingFacts } = await import(SUT)
    await provisionFresh('conv-here-1')
    expect(roster.at(-1)?.name).toBe('Claude 1')
    // 另一台设备用掉了 2、3:服务端账本到 3,并给本账号每台设备推 agent_changed。
    serverSerials = new Map([['Claude', 3]])
    const ledgerLanded = nextLedgerRead()
    refreshAgentNamingFacts({ accessToken: 'token', userId: 'owner-1' })
    await awaitPending('账本读数落进本机起点', ledgerLanded)
    await provisionFresh('conv-here-2')
    expect(roster.at(-1)?.name).toBe('Claude 4')
  })
  it('推送成批到达 ⇒ 在途时再来的合并成一次补取,❌ 每条推送各打一发', async () => {
    const { refreshAgentNamingFacts } = await import(SUT)
    const { listAgentNameSerialsViaSupabase } = await import('@gugu/core/cloud/agentIdentityReconcile')
    const lister = vi.mocked(listAgentNameSerialsViaSupabase)
    lister.mockClear()
    let release!: () => void
    lister.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(serverSerials) }))
    for (let i = 0; i < 5; i++) refreshAgentNamingFacts({ accessToken: 'token', userId: 'owner-1' })
    expect(lister).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(lister).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lister, '在途那一发结束后只补一发').toHaveBeenCalledTimes(2)
  })
  it('别的账号停放在本机的 agent 不占这个账号的号', async () => {
    roster.push({ id: 'rec-other', name: 'Claude 90', agent_type: 'claude-code', gugu_user_id: 'a-o', cache: { sessionpage_owner_user_id: 'someone-else' } })
    await provisionFresh('conv-mine')
    expect(roster.at(-1)?.name).toBe('Claude 1')
  })
  it('本进程发过的号即使名册里那一行删了也不再发', async () => {
    await provisionFresh('conv-a')
    await provisionFresh('conv-b')
    expect(roster.map((r) => r.name)).toEqual(['Claude 1', 'Claude 2'])
    roster.splice(1, 1)
    await provisionFresh('conv-c')
    expect(roster.map((r) => r.name)).toEqual(['Claude 1', 'Claude 3'])
  })
  describe('一次往返路径(本机身份先起、云端后台补)', () => {
    const oneTripCalls: Array<{ displayName: string; nameMode: string }> = []
    let serverLift = 0
    const oneTripDeps = {
      ...deps,
      get env(): NodeJS.ProcessEnv {
        return { GUGU_HOME: home } as NodeJS.ProcessEnv
      },
      listAgentNameSerials: async () => new Map<string, number>(),
      provisionOneTrip: async (input: { agentId: string; displayName: string; nameMode: string }) => {
        oneTripCalls.push({ displayName: input.displayName, nameMode: input.nameMode })
        // 服务端按自己的账本把偏低的候选往上抬(另一台电脑刚发过号)。
        const serial = Number(/ (\d+)$/.exec(input.displayName)?.[1] ?? 0)
        const lifted = input.nameMode === 'serial' && serverLift > serial ? `Claude ${serverLift}` : input.displayName
        return { agentId: input.agentId, displayName: lifted, groupChatId: '', groupCreated: false, priorGroupState: 'none' }
      },
    }
    beforeEach(() => {
      oneTripCalls.length = 0
      serverLift = 0
    })
    // 第 19 条(10-12):开户失败(项目群满了),#5419 撤掉这次铸的身份;会话照跑,手里还是发给它的 gugu MCP 卡。
    // 这条会话再起来要铸新身份 —— 先收旧身份的卡,host 才肯给新身份发卡(同一条会话不许换主体)。撤行那一刻 ❌ 收:
    // 照跑的会话会当场没了 gugu MCP。别的会话不动;落了地的身份重开是复用,什么也不收。
    it('开户失败撤掉的身份:这条会话下次铸身份之前先收它的卡,撤行那一刻不收', async () => {
      const { setSessionpageAgentCardRevoker, setCloudProvisionRetryDelaysForTests } = await import(SUT)
      const revoked: string[] = []
      setSessionpageAgentCardRevoker(async (agentUserId: string) => { revoked.push(agentUserId) })
      setCloudProvisionRetryDelaysForTests([0, 0])
      const groupFull = {
        ...oneTripDeps,
        provisionOneTrip: async () => {
          throw new Error('provision_taskpage_agent failed (400): cannot add agent to project group g: member_limit_reached')
        },
      }
      try {
        const first = await provisionFresh('conv-full', {}, groupFull)
        expect(roster.some((r) => r.gugu_user_id === first.guguAgentUserId), '#5419 撤掉了本机那一行').toBe(false)
        expect(revoked, '撤行那一刻不收:会话还在用这张卡').toEqual([])
        await provisionFresh('conv-other', {}, oneTripDeps)
        expect(revoked, '别的会话铸身份不收它的卡').toEqual([])
        const second = await provisionFresh('conv-full', {}, oneTripDeps)
        expect(second.guguAgentUserId).not.toBe(first.guguAgentUserId)
        expect(revoked).toEqual([first.guguAgentUserId])
        await provisionFresh('conv-full', {}, oneTripDeps)
        expect(revoked, '这次落了地:重开是复用,不再收').toEqual([first.guguAgentUserId])
      } finally {
        setSessionpageAgentCardRevoker(null)
        setCloudProvisionRetryDelaysForTests([2_000, 8_000])
      }
    })
    // 评审 r1 ②:终端会话「接回」时引擎没换,手里还是旧卡 ⇒ 身份被撤过就不铸、不收,当场说清;重新开才换新身份。
    it('身份被撤过的会话接回:不铸新身份、不收卡,说清要重新开;重新开时照常先收卡再铸', async () => {
      const { setSessionpageAgentCardRevoker, setCloudProvisionRetryDelaysForTests, assertSessionpageIdentityForReattach } = await import(SUT)
      const revoked: string[] = []
      setSessionpageAgentCardRevoker(async (agentUserId: string) => { revoked.push(agentUserId) })
      setCloudProvisionRetryDelaysForTests([0, 0])
      const groupFull = {
        ...oneTripDeps,
        provisionOneTrip: async () => {
          throw new Error('provision_taskpage_agent failed (400): cannot add agent to project group g: member_limit_reached')
        },
      }
      try {
        expect(() => assertSessionpageIdentityForReattach('conv-tui'), '没撤过身份:照常接回').not.toThrow()
        const first = await provisionFresh('conv-tui', {}, groupFull)
        const rosterBefore = roster.length
        expect(() => assertSessionpageIdentityForReattach('conv-tui')).toThrow('要重新开这个会话(不是接回)才能换新身份')
        expect(revoked, '接回:不收卡').toEqual([])
        expect(roster.length, '接回:不铸新身份').toBe(rosterBefore)
        await provisionFresh('conv-tui', {}, oneTripDeps)
        expect(revoked, '重新开:先收旧卡再铸').toEqual([first.guguAgentUserId])
        expect(() => assertSessionpageIdentityForReattach('conv-tui')).not.toThrow()
      } finally {
        setSessionpageAgentCardRevoker(null)
        setCloudProvisionRetryDelaysForTests([2_000, 8_000])
      }
    })
    it('新会话按 serial 递候选;服务端抬过的号成为下一条的起点', async () => {
      await provisionFresh('conv-1', {}, oneTripDeps)
      expect(oneTripCalls).toEqual([{ displayName: 'Claude 1', nameMode: 'serial' }])
      serverLift = 7
      await provisionFresh('conv-2', {}, oneTripDeps)
      expect(oneTripCalls[1]).toEqual({ displayName: 'Claude 2', nameMode: 'serial' })
      serverLift = 0
      await provisionFresh('conv-3', {}, oneTripDeps)
      expect(oneTripCalls[2], '服务端定下的 Claude 7 已经用过').toEqual({ displayName: 'Claude 8', nameMode: 'serial' })
    })
    it('服务端把名字往上改了 ⇒「身份就绪」事件带上原来的名字,听的人据此告诉那条会话;没改名就不带', async () => {
      const { onSessionpageAgentProvisioned } = await import(SUT)
      const seen: Array<{ displayName: string; renamedFrom?: string }> = []
      const off = onSessionpageAgentProvisioned((e: { displayName: string; renamedFrom?: string }) => seen.push(e))
      try {
        await provisionFresh('conv-kept', {}, oneTripDeps)
        serverLift = 7
        await provisionFresh('conv-lifted', {}, oneTripDeps)
      } finally {
        off()
      }
      expect(seen.map((e) => [e.displayName, e.renamedFrom])).toEqual([
        ['Claude 1', undefined],
        ['Claude 7', 'Claude 2'],
      ])
    })
    it('云端那一发没落地的会话重开 ⇒ 按原名补登记(explicit 保名),❌ 按 serial 被往上改名', async () => {
      roster.push({
        id: 'rec-pending', name: 'Claude 29', agent_type: 'claude-code', gugu_user_id: 'a-pending',
        cache: {
          emdash_session_id: 'conv-pending',
          sessionpage_owner_user_id: 'owner-1',
          sessionpage_cloud_identity_state: 'pending',
        },
      })
      await provisionFresh('conv-pending', {}, oneTripDeps)
      expect(oneTripCalls).toEqual([{ displayName: 'Claude 29', nameMode: 'explicit' }])
    })
  })
})
describe('spec ⑨ 删除侧:删除必同步,且只摘该摘的', () => {
  const reapDeps = (inventory: { sessionIds: string[]; projectIds: string[] }) => ({
    getAuth: deps.getAuth,
    resolveDeviceId: deps.resolveDeviceId,
    getInventory: async () => inventory,
    env: { GUGU_HOME: home } as NodeJS.ProcessEnv,
  })
  it('orphan archival retains the identity for a later task Restore', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-keep', providerId: 'codex', surface: 'tui', cwd: '/w/k', projectId: '' }, deps)
    const gone = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-archived', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: '' }, deps)
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-keep'], projectIds: [] }))
    expect(res.reapedAgents).toBe(1)
    expect(tombstones).toEqual([])
    expect(roster.find(row => row.gugu_user_id === gone!.guguAgentUserId)?.status).toBe('archived')
    const again = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-archived', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: '' }, deps)
    expect(again?.guguAgentUserId, '取消归档后再驱动 ⇒ 重新开户').toBeTruthy()
    expect(again!.guguAgentUserId).toBe(gone!.guguAgentUserId)
  })
  it('别家账号的行:会话没了也不动,留给主人;主人登录后再收', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const asB = { ...deps, getAuth: async () => ({ accessToken: 'token-b', refreshToken: 'r', userId: 'owner-B' }) }
    const a = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: '' }, deps)
    const b = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: '' }, asB)
    const inventory = { sessionIds: ['conv-a'], projectIds: [] }
    const asAReap = await reconcileSessionpageAgents(reapDeps(inventory))
    expect(asAReap.reapedAgents, 'A 不收 B 的').toBe(0)
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(roster.map((r) => r.gugu_user_id).sort(), 'B 的行留在名册里')
      .toEqual([a!.guguAgentUserId, b!.guguAgentUserId].sort())
    const asBReap = await reconcileSessionpageAgents({ ...reapDeps(inventory), getAuth: asB.getAuth })
    expect(asBReap.reapedAgents).toBe(1)
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(agentsForOwner(roster, null).map((r) => r.gugu_user_id)).toEqual([a!.guguAgentUserId])
    expect(roster).toHaveLength(2)
  })
  it('会话没了(归档/删除)→ 摘掉它的 agent;其它 agent 不受牵连', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const {
      localSessionDeliveryTarget,
      registerOfflineLocalSessionDelivery,
    } = await import('../../../../apps/desktop/electron/sessionpage/local-session-delivery')
    const a = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const b = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: 'proj-alpha' }, deps)
    registerOfflineLocalSessionDelivery(a!.guguAgentUserId, {
      sessionId: 'conv-a',
      providerId: 'codex',
    })
    const res = await reconcileSessionpageAgents(
      reapDeps({ sessionIds: ['conv-b'], projectIds: ['proj-alpha'] }),
    )
    expect(res.reapedAgents).toBe(1)
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(agentsForOwner(roster, null).map((r) => r.gugu_user_id)).toEqual([b!.guguAgentUserId])
    expect(roster).toHaveLength(2)
    expect(res.archivedGroups, '项目还在 → 群不动').toBe(0)
    expect(localSessionDeliveryTarget.liveSessionIdByAgent(a!.guguAgentUserId)).toBeNull()
  })
  it('reuses an active binding without resetting its status; restoring archive alone resets it to idle', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const input = { sessionId: 'conv-status', providerId: 'codex', surface: 'tui' as const, cwd: '/w/a', projectId: 'proj-alpha' }
    const first = await provisionSessionpageAgentForSession(input, deps)
    await settleCloud()
    roster[0].status = 'working'
    expect((await provisionSessionpageAgentForSession(input, deps))?.guguAgentUserId).toBe(first?.guguAgentUserId)
    expect(roster[0].status).toBe('working')
    roster[0].status = 'archived'
    expect((await provisionSessionpageAgentForSession(input, deps))?.guguAgentUserId).toBe(first?.guguAgentUserId)
    expect(roster[0].status).toBe('idle')
  })
  it('never attempts identity or membership removal when the task is missing', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession({ sessionId: 'missing', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const members = [...groups[0].members]
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['missing'], projectIds: ['proj-alpha'] }))
    await reconcileSessionpageAgents(reapDeps({ sessionIds: [], projectIds: ['proj-alpha'] }))
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(groups[0].members).toEqual(members)
    expect(roster[0].status).toBe('archived')
    expect(tombstones).toEqual([])
  })
  it('项目没了 → 归档镜像它的群,并摘掉它产生的 agent', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const groupId = groups[0].chatId
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: [], projectIds: [] }))
    expect(res.reapedAgents).toBe(1)
    expect(res.archivedGroups).toBe(1)
    expect(chatUpdates, '群被置为 archived(咕咕没有群硬删能力)').toEqual(
      expect.arrayContaining([{ table: 'chats', patch: { status: 'archived' }, id: groupId }]))
    expect(agentsForOwner(roster, null)).toHaveLength(0)
    expect(roster).toHaveLength(1)
  })
  it('什么都没少 → 一个都不摘(不会误删)', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    expect(res).toEqual({ reapedAgents: 0, archivedGroups: 0 })
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(roster).toHaveLength(1)
  })
  it('云端家在本机、本安装名册里没有的 agent ⇒ 不删(重装 / 同机另一个数据目录 / agents.json 为 {} 都长这样)', async () => {
    const { reconcileSessionpageAgents } = await import(REAPER)
    // device_id 按(机器, 账号, tier)派生,不跟数据目录走:另一个实例、重装前、清空名册之前铸的 agent 在云端都是
    // 「家在本机、这份名册里没有」。回收只看本安装自己的名册行与会话清单,不去云端按缺席找人。
    for (const inventory of [{ sessionIds: [], projectIds: [] }, { sessionIds: ['conv-here'], projectIds: ['proj-here'] }]) {
      const res = await reconcileSessionpageAgents(reapDeps(inventory))
      expect(res).toEqual({ reapedAgents: 0, archivedGroups: 0 })
    }
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(rpcCalls.map((call) => call.name)).not.toContain('remove_owned_agent')
  })
  it('清单中缺失的任务归档名册,仍在的任务保持活动', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: 'proj-alpha' }, deps)
    const res = await reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: ['conv-b'], projectIds: ['proj-alpha'] }),
    })
    expect(res.reapedAgents, '缺失任务只归档它自己的名册').toBe(1)
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(agentsForOwner(roster, null).map((r) => r.name), '同项目里活着的 agent 不受牵连').toEqual(['Codex 2'])
  })
  it('detach 不点名任何会话 → 一个都不摘(会话还活着)', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const res = await reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }),
    })
    expect(res).toEqual({ reapedAgents: 0, archivedGroups: 0 })
    expect(roster).toHaveLength(1)
  })
  it('项目里最后一个 agent 被摘走 → 同项目的下一个会话仍回到原来那个群', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const firstGroupId = groups[0].chatId
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: [], projectIds: ['proj-alpha'] }))
    expect(res.reapedAgents).toBe(1)
    expect(agentsForOwner(roster, null)).toHaveLength(0)
    expect(roster).toHaveLength(1)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-c', providerId: 'codex', surface: 'tui', cwd: '/w/c', projectId: 'proj-alpha' }, deps)
    expect(groups[0].chatId, '回到原来那个群').toBe(firstGroupId)
    expect(groups, '❌ 没有多出第二个同名群').toHaveLength(1)
  })
  it('项目没了(群已归档)→ 忘掉映射,同 id 项目再出现时不复用归档群', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const { readProjectGroupId } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups')
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const firstGroupId = groups[0].chatId
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: [], projectIds: [] }))
    expect(res.archivedGroups).toBe(1)
    expect(roster).toHaveLength(1)
    expect(roster[0].status).toBe('archived')
    const archivedAgentId = roster[0].gugu_user_id
    expect(await readProjectGroupId('proj-alpha', 'owner-1', deps.env)).toBeNull()
    groups.length = 0 // 归档的群不再算「可复用的活群」(替身的 groupExists 按这个数组回答)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-d', providerId: 'codex', surface: 'tui', cwd: '/w/d', projectId: 'proj-alpha' }, deps)
    expect(groups[0].chatId, '建了新群,不复用归档的那个').not.toBe(firstGroupId)
    expect(groups).toHaveLength(1)
    expect(await readProjectGroupId('proj-alpha', 'owner-1', deps.env)).toBe(groups[0].chatId)
    expect(roster.find((agent) => agent.gugu_user_id === archivedAgentId)?.status).toBe('archived')
  })
  it('清单不自洽(有会话却零项目)→ 拒绝归档任何群,只按会话摘 agent', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: 'proj-alpha' }, deps)
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-b'], projectIds: [] }))
    expect(res.archivedGroups, '不自洽 → 一个群都不归档').toBe(0)
    expect(chatUpdates, '没有任何 chats 被改状态').toEqual([])
    expect(res.reapedAgents, '摘 agent 照常(它只依赖会话清单)').toBe(1)
  })
  it('项目真的全删了(会话也随之为空)→ 该归档还是归档', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: [], projectIds: [] }))
    expect(res.archivedGroups, '级联把会话也带走了 → 守卫不该误伤这条真删除').toBe(1)
  })
  it('用户自己建的 agent(无会话绑定)绝不被碰', async () => {
    const { reconcileSessionpageAgents } = await import(REAPER)
    roster.push({ id: 'rec-own', name: '我的助手', agent_type: 'codex', gugu_user_id: 'mine', cache: null })
    const res = await reconcileSessionpageAgents(reapDeps({ sessionIds: [], projectIds: [] }))
    expect(res.reapedAgents).toBe(0)
    expect(roster.map((r) => r.gugu_user_id)).toEqual(['mine'])
  })
})
describe('项目→群 映射:并发不丢条目、读失败必出声', () => {
  const MAPPING = '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'
  const OWNER = 'owner-1'
  it('两个项目并发写入,两条都在(❌ 后写覆盖先写)', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    const env = { GUGU_HOME: home } as NodeJS.ProcessEnv
    await Promise.all([
      rememberProjectGroupId('proj-alpha', 'chat-alpha', OWNER, env),
      rememberProjectGroupId('proj-beta', 'chat-beta', OWNER, env),
    ])
    expect(await readProjectGroupId('proj-alpha', OWNER, env)).toBe('chat-alpha')
    expect(await readProjectGroupId('proj-beta', OWNER, env)).toBe('chat-beta')
  })
  it('文件坏了 → 报错出声,而不是静默当成「这个项目还没有群」', async () => {
    const { readProjectGroupId } = await import(MAPPING)
    const env = { GUGU_HOME: home } as NodeJS.ProcessEnv
    await writeFile(join(home, 'taskpage-project-groups.json'), '{ 这不是 JSON', 'utf8')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readProjectGroupId('proj-alpha', OWNER, env)).toBeNull()
    expect(spy, '坏文件必须响亮地喊出来(否则重复建群这个 bug 会静默复发)').toHaveBeenCalled()
    spy.mockRestore()
  })
  it('首次运行(文件不存在)不吵:那是正常状态', async () => {
    const { readProjectGroupId } = await import(MAPPING)
    const env = { GUGU_HOME: home } as NodeJS.ProcessEnv
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readProjectGroupId('proj-alpha', OWNER, env)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('按账号分区:同一项目两个账号各记各的群,互不覆盖', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    const env = { GUGU_HOME: home } as NodeJS.ProcessEnv
    await rememberProjectGroupId('proj-alpha', 'chat-of-A', 'owner-A', env)
    await rememberProjectGroupId('proj-alpha', 'chat-of-B', 'owner-B', env)
    expect(await readProjectGroupId('proj-alpha', 'owner-A', env)).toBe('chat-of-A')
    expect(await readProjectGroupId('proj-alpha', 'owner-B', env)).toBe('chat-of-B')
    expect(await readProjectGroupId('proj-alpha', 'owner-C', env), '没记过的账号什么都拿不到').toBeNull()
  })
  it('v1 平铺文件:条目先当「不知道归谁」给任何账号候选,被认领后归入该账号、平铺条目清掉', async () => {
    const { rememberProjectGroupId, readProjectGroupId, forgetProjectGroupId } = await import(MAPPING)
    const env = { GUGU_HOME: home } as NodeJS.ProcessEnv
    await writeFile(join(home, 'taskpage-project-groups.json'), JSON.stringify({ 'proj-alpha': 'chat-v1' }), 'utf8')
    expect(await readProjectGroupId('proj-alpha', 'owner-A', env), 'v1 条目对 A 是候选').toBe('chat-v1')
    expect(await readProjectGroupId('proj-alpha', 'owner-B', env), 'v1 条目对 B 也是候选').toBe('chat-v1')
    await rememberProjectGroupId('proj-alpha', 'chat-v1', 'owner-A', env)
    const written = JSON.parse(await readFile(join(home, 'taskpage-project-groups.json'), 'utf8')) as {
      owners: Record<string, Record<string, string>>
      unowned: Record<string, string>
    }
    expect(written.owners['owner-A']).toEqual({ 'proj-alpha': 'chat-v1' })
    expect(written.unowned, '认领后平铺条目清掉,B 不再拿它当候选').toEqual({})
    expect(await readProjectGroupId('proj-alpha', 'owner-B', env)).toBeNull()
    await forgetProjectGroupId('proj-alpha', 'owner-A', env)
    expect(await readProjectGroupId('proj-alpha', 'owner-A', env)).toBeNull()
  })
  it('同机项目共群:映射只记「项目 → 群」,撤销一个不误删另一个;旧文件里的 representatives 读时不认、写时去掉', async () => {
    const { rememberProjectGroupId, listProjectGroupIds, forgetProjectGroupId } = await import(MAPPING)
    const env = { GUGU_HOME: home } as NodeJS.ProcessEnv
    await writeFile(join(home, 'taskpage-project-groups.json'), JSON.stringify({ owners: {}, unowned: {}, representatives: { [OWNER]: { 'chat-shared': 'z-target' } } }))
    await rememberProjectGroupId('z-target', 'chat-shared', OWNER, env)
    await rememberProjectGroupId('a-source', 'chat-old', OWNER, env)
    await rememberProjectGroupId('a-source', 'chat-shared', OWNER, env)
    expect(await listProjectGroupIds(OWNER, env)).toEqual([
      { projectId: 'z-target', chatId: 'chat-shared' },
      { projectId: 'a-source', chatId: 'chat-shared' },
    ])
    await forgetProjectGroupId('a-source', OWNER, env)
    expect(await listProjectGroupIds(OWNER, env)).toEqual([{ projectId: 'z-target', chatId: 'chat-shared' }])
    expect(JSON.parse(await readFile(join(home, 'taskpage-project-groups.json'), 'utf8'))).not.toHaveProperty('representatives')
  })
})
const FOOTPRINT = '../../../../apps/desktop/electron/sessionpage/agent-local-footprint'
describe('#4526 A:owner 删除 ⇒ 释放本机足迹 + 墓碑挡住重新开户', () => {
  async function provisionOne(sessionId: string) {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    return provisionSessionpageAgentForSession(
      { sessionId, providerId: 'codex', surface: 'tui', cwd: '/w', projectId: '' },
      deps,
    )
  }
  it('花名册 / runtime session / runtime activity 三处都被摘掉,并按 conversation 立碑', async () => {
    const provisioned = await provisionOne('conv-del')
    const agentId = provisioned.guguAgentUserId
    expect(roster.map((r) => r.gugu_user_id), '删除前花名册里应当有它').toContain(agentId)
    expect(roster.find((r) => r.gugu_user_id === agentId)?.cache?.emdash_session_id).toBe('conv-del')
    expect(tombstones, '删除前不该有墓碑').toHaveLength(0)
    const { releaseAgentLocalFootprint } = await import(FOOTPRINT)
    const result = await releaseAgentLocalFootprint({
      agentUserId: agentId,
      identityRemoved: true,
      env: { GUGU_HOME: home } as NodeJS.ProcessEnv,
    })
    expect(result.rosterRemoved).toBe(true)
    expect(result.sessionId, '会话绑定必须在摘记录之前读出来,否则墓碑立不了').toBe('conv-del')
    expect(roster.map((r) => r.gugu_user_id), '花名册记录必须消失').not.toContain(agentId)
    expect(removedRuntimeSessions, 'runtime session 文件必须删').toContain(agentId)
    expect(tombstones).toEqual([
      expect.objectContaining({ gugu_user_id: agentId, conversation_id: 'conv-del' }),
    ])
  })
  it('删完之后同一条会话再 session start ⇒ 不再开户(而不是造一个新身份回来)', async () => {
    const provisioned = await provisionOne('conv-del')
    const originalAgentId = provisioned.guguAgentUserId
    const { releaseAgentLocalFootprint } = await import(FOOTPRINT)
    await releaseAgentLocalFootprint({
      agentUserId: originalAgentId,
      identityRemoved: true,
      env: { GUGU_HOME: home } as NodeJS.ProcessEnv,
    })
    const again = await provisionOne('conv-del')
    expect(again, '被 owner 删掉的会话此后没有可寻址身份').toBeNull()
    expect(roster, '❌ 绝不能因为花名册空了就当成「全新会话」重新开户').toHaveLength(0)
    const fresh = await provisionOne('conv-alive')
    expect(fresh?.guguAgentUserId, '没被删过的会话必须照常开户,否则这道闸判不了假').toBeTruthy()
    expect(roster).toHaveLength(1)
  })
  it('not-homed(身份在别的设备上活着)不立碑 ⇒ 那条会话仍可开户', async () => {
    const provisioned = await provisionOne('conv-nothome')
    const { releaseAgentLocalFootprint } = await import(FOOTPRINT)
    await releaseAgentLocalFootprint({
      agentUserId: provisioned.guguAgentUserId,
      identityRemoved: false,
      env: { GUGU_HOME: home } as NodeJS.ProcessEnv,
    })
    expect(roster).toHaveLength(1)
    expect(roster[0].status).toBe('archived')
    expect(tombstones, 'not-homed 不是删除:身份还活着,不能立「永久不可达」的碑').toHaveLength(0)
    const again = await provisionOne('conv-nothome')
    expect(again?.guguAgentUserId).toBe(provisioned.guguAgentUserId)
  })
})

describe('#7341 项目群跨设备:预留的群 id、别的机器还在用的群不归档', () => {
  const MAPPING = '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'
  const env = (): NodeJS.ProcessEnv => ({ GUGU_HOME: home } as NodeJS.ProcessEnv)
  const reapDeps = (inventory: { sessionIds: string[]; projectIds: string[] }) => ({
    getAuth: deps.getAuth,
    resolveDeviceId: deps.resolveDeviceId,
    getInventory: async () => inventory,
    env: env(),
  })
  const archived = () => chatUpdates.filter((u) => u.patch.status === 'archived').map((u) => u.id)

  it('对照里是一个云端还没建的群(预留的 / 另一台机器并进来时记下的)⇒ 第一个 agent 就用这个 id 建群', async () => {
    const { rememberProjectGroupId } = await import(MAPPING)
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await rememberProjectGroupId('proj-alpha', 'reserved-group', 'owner-1', env())
    const a = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-r', providerId: 'codex', surface: 'tui', cwd: '/w/r', projectId: 'proj-alpha' }, deps)
    await settleCloud()
    expect(groups.map((g) => g.chatId), '❌ 另起一个 id(两台机器会各记各的群)').toEqual(['reserved-group'])
    expect(groups[0]!.members).toContain(a!.guguAgentUserId)
  })

  it('预留的 id 刚被别处用它建出来(撞主键)⇒ 加座位进那个群', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await rememberProjectGroupId('proj-alpha', 'reserved-taken', 'owner-1', env())
    beforeCreateGroup = vi.fn((args) => {
      if (args.p_chat_id !== 'reserved-taken') return
      groups.push({ chatId: 'reserved-taken', name: '阿尔法项目', members: ['owner-1'] })
      return { error: { code: '23505', message: 'duplicate key value violates unique constraint "chats_pkey"' } }
    })
    const a = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-r', providerId: 'codex', surface: 'tui', cwd: '/w/r', projectId: 'proj-alpha' }, deps)
    await settleCloud()
    expect(beforeCreateGroup).toHaveBeenCalledOnce()
    expect(groups.map((g) => g.chatId)).toEqual(['reserved-taken'])
    expect(groups[0]!.members).toContain(a!.guguAgentUserId)
    expect(await readProjectGroupId('proj-alpha', 'owner-1', env())).toBe('reserved-taken')
  })

  it('预留的 id 撞上一个这个账号看不见的群 ⇒ 另建一个,对照改指它', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    const { provisionSessionpageAgentForSession } = await import(SUT)
    await rememberProjectGroupId('proj-alpha', 'reserved-foreign', 'owner-1', env())
    beforeCreateGroup = vi.fn((args) => args.p_chat_id === 'reserved-foreign'
      ? { error: { code: '23505', message: 'duplicate key value violates unique constraint "chats_pkey"' } }
      : undefined)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-r', providerId: 'codex', surface: 'tui', cwd: '/w/r', projectId: 'proj-alpha' }, deps)
    await settleCloud()
    expect(groups).toHaveLength(1)
    expect(beforeCreateGroup).toHaveBeenCalledOnce()
    expect(groups[0]!.chatId).not.toBe('reserved-foreign')
    expect(await readProjectGroupId('proj-alpha', 'owner-1', env())).toBe(groups[0]!.chatId)
  })

  it('项目在这台机器上没了、群里还有别的机器上的 agent ⇒ 不归档,只忘掉这台的对照;本机的 agent 照收', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const { listProjectGroupIds } = await import(MAPPING)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const groupId = groups[0]!.chatId
    const checker = vi.fn(async () => ['agent-on-the-other-machine'])
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    const res = await reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: [], projectIds: [] }),
      listGroupAgentsElsewhere: checker,
    })
    expect(checker).toHaveBeenCalledWith({ chatId: groupId, deviceId: 'device-1', accessToken: 'token', ownerUserId: 'owner-1' })
    expect(res.archivedGroups).toBe(0)
    expect(archived(), '别的机器还在用 ⇒ ❌ 归档').toEqual([])
    expect(await listProjectGroupIds('owner-1', env()), '这台机器上的对照忘掉').toEqual([])
    expect(res.reapedAgents, '本机这个项目的 agent 照样收').toBe(1)
  })

  it('群里只剩本机的 agent ⇒ 照旧归档', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const groupId = groups[0]!.chatId
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    const res = await reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: [], projectIds: [] }),
      listGroupAgentsElsewhere: async () => [],
    })
    expect(res.archivedGroups).toBe(1)
    expect(archived()).toEqual([groupId])
  })

  it('查不出别的机器在不在用 ⇒ 不归档、对照不动,并且响亮失败(fail closed)', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const { listProjectGroupIds } = await import(MAPPING)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const groupId = groups[0]!.chatId
    await reconcileSessionpageAgents(reapDeps({ sessionIds: ['conv-a'], projectIds: ['proj-alpha'] }))
    await expect(reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: [], projectIds: [] }),
      listGroupAgentsElsewhere: async () => { throw new Error('network down') },
    })).rejects.toThrow(/check other machines before archiving: network down/)
    expect(archived()).toEqual([])
    expect(await listProjectGroupIds('owner-1', env()), '映射留着,下次触发再判').toEqual([{ projectId: 'proj-alpha', chatId: groupId }])
    expect(roster, '保留归档名册以便恢复').toHaveLength(1)
    expect(roster[0].status).toBe('archived')
  })

  it('本机设备还没解析出来 ⇒ 判不了别的机器,这一轮不归档', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-b', providerId: 'codex', surface: 'tui', cwd: '/w/b', projectId: 'proj-beta' }, deps)
    const checker = vi.fn(async () => [])
    // 会话都还在(这一轮不收 agent),只有 proj-alpha 没了:单看「项目群归不归档」这一格。
    const res = await reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: ['conv-a', 'conv-b'], projectIds: ['proj-beta'] }),
      resolveDeviceId: async () => null,
      listGroupAgentsElsewhere: checker,
    })
    expect(res.archivedGroups).toBe(0)
    expect(checker).not.toHaveBeenCalled()
    expect(archived()).toEqual([])
  })

  it('这台机器上另一个还在的项目也绑着这个群 ⇒ 不归档,只忘掉没了的那个项目的对照', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const { rememberProjectGroupId, listProjectGroupIds } = await import(MAPPING)
    await provisionSessionpageAgentForSession(
      { sessionId: 'conv-a', providerId: 'codex', surface: 'tui', cwd: '/w/a', projectId: 'proj-alpha' }, deps)
    const groupId = groups[0]!.chatId
    await rememberProjectGroupId('proj-beta', groupId, 'owner-1', env())
    const checker = vi.fn(async () => [])
    const res = await reconcileSessionpageAgents({
      ...reapDeps({ sessionIds: [], projectIds: ['proj-beta'] }),
      listGroupAgentsElsewhere: checker,
    })
    expect(res.archivedGroups).toBe(0)
    expect(archived()).toEqual([])
    expect(checker, '本机就判得出来,不必问云端').not.toHaveBeenCalled()
    expect(await listProjectGroupIds('owner-1', env())).toEqual([{ projectId: 'proj-beta', chatId: groupId }])
  })

  describe('listGroupAgentsOnOtherDevices(默认的那一问)', () => {
    const membersOf = (rows: Array<{ user_id: string }> | null, error: { message: string } | null = null) => ({
      from: () => ({ select: () => ({ eq: async () => ({ data: rows, error }) }) }),
    })
    const usersOf = (rows: Array<{ id: string; type: string; device_id: string | null }>) => ({
      from: () => ({ select: () => ({ in: async (_column: string, ids: string[]) => ({ data: rows.filter((r) => ids.includes(r.id)), error: null }) }) }),
    })
    it('只数家在别的机器上的 agent:人、群主自己、本机的 agent 都不算;不知道在哪的 agent 按「别处」算', async () => {
      const { listGroupAgentsOnOtherDevices } = await import(REAPER)
      const got = await listGroupAgentsOnOtherDevices({
        chat: membersOf([{ user_id: 'owner-1' }, { user_id: 'human-2' }, { user_id: 'agent-here' }, { user_id: 'agent-there' }, { user_id: 'agent-unknown' }]),
        identity: () => usersOf([
          { id: 'owner-1', type: 'human', device_id: null },
          { id: 'human-2', type: 'human', device_id: null },
          { id: 'agent-here', type: 'agent', device_id: 'device-1' },
          { id: 'agent-there', type: 'agent', device_id: 'device-2' },
          { id: 'agent-unknown', type: 'agent', device_id: null },
        ]),
        chatId: 'chat-1',
        deviceId: 'device-1',
        ownerUserId: 'owner-1',
      })
      expect(got).toEqual(['agent-there', 'agent-unknown'])
    })
    it('群里只有群主 ⇒ 不必再查身份', async () => {
      const { listGroupAgentsOnOtherDevices } = await import(REAPER)
      const identity = vi.fn(() => usersOf([]))
      expect(await listGroupAgentsOnOtherDevices({
        chat: membersOf([{ user_id: 'owner-1' }]), identity, chatId: 'chat-1', deviceId: 'device-1', ownerUserId: 'owner-1',
      })).toEqual([])
      expect(identity).not.toHaveBeenCalled()
    })
    it('读成员失败 ⇒ 抛(调用方据此不归档,❌ 当成「没人在用」)', async () => {
      const { listGroupAgentsOnOtherDevices } = await import(REAPER)
      await expect(listGroupAgentsOnOtherDevices({
        chat: membersOf(null, { message: 'permission denied' }),
        identity: () => usersOf([]),
        chatId: 'chat-1',
        deviceId: 'device-1',
        ownerUserId: 'owner-1',
      })).rejects.toThrow(/permission denied/)
    })
  })
})
// 放在文件最后:它要一个从没读出过非空清单的回收器进程(那是模块级事实,前面的用例早把它置真了),
// resetModules 之后的模块不该再被别的用例继承。
describe('#3969 新进程第一次归档唯一的任务', () => {
  it('retains identity, name and seats through archive reconciliation, restart and restored provisioning', async () => {
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const input = { sessionId: 'conv-kept', providerId: 'codex', surface: 'tui' as const, cwd: '/w/kept', projectId: 'proj-alpha' }
    const original = await provisionSessionpageAgentForSession(input, deps)
    await settleCloud()
    const name = roster[0].name
    const members = [...groups[0].members]
    const inventory = { getAuth: deps.getAuth, resolveDeviceId: deps.resolveDeviceId,
      getInventory: async () => ({ sessionIds: ['conv-kept'], projectIds: ['proj-alpha'] }), env: { GUGU_HOME: home } }
    expect((await reconcileSessionpageAgents(inventory)).reapedAgents).toBe(0)
    vi.resetModules()
    const restarted = await import(REAPER)
    expect((await restarted.reconcileSessionpageAgents(inventory)).reapedAgents).toBe(0)
    const provision = await import(SUT)
    const restored = await provision.provisionSessionpageAgentForSession(input, deps)
    await settleCloud()
    expect(restored?.guguAgentUserId).toBe(original?.guguAgentUserId)
    expect(roster[0].name).toBe(name); expect(roster).toHaveLength(1)
    expect(groups[0].members).toEqual(members); expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    const fresh = await provision.provisionSessionpageAgentForSession({ ...input, sessionId: 'conv-new', cwd: '/w/new' }, deps)
    await settleCloud()
    expect(fresh?.guguAgentUserId).not.toBe(original?.guguAgentUserId)
    expect(roster).toHaveLength(2); expect(groups[0].members).toHaveLength(members.length + 1)
  })
  it('首次空清单不猜缺席;读出过非空清单后才能归档缺失任务', async () => {
    vi.resetModules()
    const { provisionSessionpageAgentForSession } = await import(SUT)
    const { reconcileSessionpageAgents } = await import(REAPER)
    const only = await provisionSessionpageAgentForSession(
      { sessionId: 'conv-only', providerId: 'codex', surface: 'tui', cwd: '/w/o', projectId: 'proj-alpha' }, deps)
    const emptyInventory = {
      getAuth: deps.getAuth,
      resolveDeviceId: deps.resolveDeviceId,
      getInventory: async () => ({ sessionIds: [], projectIds: ['proj-alpha'] }),
      env: { GUGU_HOME: home } as NodeJS.ProcessEnv,
    }
    const unnamed = await reconcileSessionpageAgents(emptyInventory)
    expect(unnamed.reapedAgents, '空清单不是删除的证据').toBe(0)
    expect(roster).toHaveLength(1)
    await reconcileSessionpageAgents({ ...emptyInventory, getInventory: async () => ({ sessionIds: ['conv-only'], projectIds: ['proj-alpha'] }) })
    const missing = await reconcileSessionpageAgents(emptyInventory)
    expect(missing.reapedAgents).toBe(1)
    expect(rpcCalls.filter(call => call.name === 'remove_owned_agent' || call.name === 'cleanup_removed_group_agent')).toEqual([])
    expect(roster).toHaveLength(1)
    expect(roster[0].gugu_user_id).toBe(only!.guguAgentUserId)
    expect(roster[0].status).toBe('archived')
  })
})
