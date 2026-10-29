// #7341 第二步 项目跨设备(product spec「挂文件夹」):项目的跨设备身份 = 它的项目群。
// 宿主这一侧的四件事 —— 读绑定 / 建群 / 并进来(owner 2026-10-17 选 A)/ 撤销 —— 打在真的「项目 → 群」对照文件上,
// 名册与云端用替身。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface RosterRec {
  id: string
  name: string
  agent_type: string
  gugu_user_id: string
  cache?: Record<string, unknown> | null
}
interface FakeGroup {
  chatId: string
  kind: 'group' | 'dm'
  status: 'active' | 'archived'
  members: Map<string, { listen_mode: string }>
  name?: string
}
const roster: RosterRec[] = []
const groups = new Map<string, FakeGroup>()
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
const memberUpdates: Array<{ chatId: string; userId: string; patch: Record<string, unknown> }> = []
const chatUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []
/** create_gugu_group 进来的那一刻(撞主键之前)做点什么:模拟另一台机器恰好抢先建了同一个 id 的群。 */
let beforeCreateGroup: ((chatId: string) => void) | null = null
/** add_group_agent 的应答替身:默认进群。 */
let addGroupAgent: (args: Record<string, unknown>) => { data?: unknown; error: { message: string } | null } = () => ({
  data: { status: 'joined' },
  error: null,
})

vi.mock('@gugu/core', () => ({
  listAgents: vi.fn(async () => roster.map((r) => ({ ...r, cache: r.cache ? { ...r.cache } : r.cache }))),
  updateAgent: vi.fn(async (selector: { guguUserId?: string }, patch: Record<string, unknown>) => {
    const rec = roster.find((r) => r.gugu_user_id === selector.guguUserId)
    if (!rec) throw new Error(`updateAgent: no roster record for ${JSON.stringify(selector)}`)
    if (patch.cache) rec.cache = patch.cache as Record<string, unknown>
    return { ...rec }
  }),
}))
vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseUrl: () => 'http://127.0.0.1:55321',
  getSupabaseAnonKey: () => 'anon-public-not-a-secret',
}))
vi.mock('@gugu/core/cloud/agentIdentityReconcile', () => ({
  listAgentNameSerialsViaSupabase: vi.fn(async () => new Map()),
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-registry', () => ({
  registerEmdashAgent: vi.fn(),
  unregisterEmdashAgent: vi.fn(),
  emdashAgentRegistry: { unregister: vi.fn() },
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry', () => ({
  prepareSessionpageDeliveryOwner: vi.fn(async () => undefined),
  unregisterSessionpageDeliveryOwners: vi.fn(async () => undefined),
}))

function fakeChat() {
  return {
    from(table: string) {
      const filters: Record<string, string> = {}
      let patch: Record<string, unknown> | null = null
      const read = (): unknown => {
        if (table === 'chats') {
          const group = groups.get(filters.id ?? '')
          return group ? { id: group.chatId, kind: group.kind, status: group.status } : null
        }
        if (table === 'chat_members') {
          const group = groups.get(filters.chat_id ?? '')
          return group && filters.user_id && group.members.has(filters.user_id) ? { user_id: filters.user_id } : null
        }
        return null
      }
      const settle = (): { error: null } => {
        if (patch && table === 'chat_members') {
          memberUpdates.push({ chatId: filters.chat_id ?? '', userId: filters.user_id ?? '', patch })
          const member = groups.get(filters.chat_id ?? '')?.members.get(filters.user_id ?? '')
          if (member && typeof patch.listen_mode === 'string') member.listen_mode = patch.listen_mode
        }
        if (patch && table === 'chats') chatUpdates.push({ id: filters.id ?? '', patch })
        return { error: null }
      }
      const chain = {
        select: () => chain,
        update: (next: Record<string, unknown>) => {
          patch = next
          return chain
        },
        eq: (column: string, value: string) => {
          filters[column] = value
          return chain
        },
        maybeSingle: async () => ({ data: read(), error: null }),
        then: (resolve: (value: { error: null }) => unknown) => resolve(settle()),
      }
      return chain
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      if (name === 'create_gugu_group') {
        const chatId = String(args.p_chat_id)
        beforeCreateGroup?.(chatId)
        if (groups.has(chatId)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "chats_pkey"' } }
        }
        const members = new Map<string, { listen_mode: string }>([[String(args.p_owner_user_id), { listen_mode: 'active' }]])
        for (const member of args.p_initial_members as Array<{ user_id: string }>) members.set(member.user_id, { listen_mode: 'mention' })
        groups.set(chatId, { chatId, kind: 'group', status: 'active', members, name: String(args.p_name) })
        return { data: { id: chatId }, error: null }
      }
      if (name === 'add_group_agent') {
        const answer = addGroupAgent(args)
        if (!answer.error && (answer.data as { status?: string } | undefined)?.status === 'joined') {
          // 主动入座(任务座位 p_as_task 只是不发入群提示)—— 与 chat.add_group_agent 同口径。
          groups.get(String(args.p_chat_id))?.members.set(String(args.p_agent_user_id), { listen_mode: 'active' })
        }
        return { ...answer, data: answer.data ? { ...answer.data as Record<string, unknown>, chat_id: String(args.p_chat_id) } : answer.data }
      }
      if (name === 'set_agent_listen_mode_as') {
        const chatId = String(args.p_chat_id), userId = String(args.p_agent_user_id), mode = String(args.p_mode)
        memberUpdates.push({ chatId, userId, patch: { listen_mode: mode } })
        const member = groups.get(chatId)?.members.get(userId)
        if (member) member.listen_mode = mode
        return { data: { chat_id: chatId, user_id: userId, listen_mode: mode }, error: null }
      }
      return { data: null, error: null }
    },
  }
}
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeChatClient: () => fakeChat(),
  makeIdentityClient: () => {
    throw new Error('identity client is not used by project group binding')
  },
  electronFetch: undefined,
}))

const SUT = '../../../../apps/desktop/electron/sessionpage/sessionpage-project-group-binding'
const MAPPING = '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'
const PROVISIONING = '../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning'
const OWNER = 'owner-1'
const IMPLICIT_PROJECT = '00000000-0000-4000-8000-000000000001'

let home = ''
let env: NodeJS.ProcessEnv = {}
let signedIn = true

async function makeHost(extraEnv: NodeJS.ProcessEnv = {}) {
  const { createSessionpageProjectGroupHost } = await import(SUT)
  return createSessionpageProjectGroupHost({
    getAuth: async () => (signedIn ? { accessToken: 'token', userId: OWNER } : null),
    env: { ...env, ...extraEnv },
  })
}

const subjectA = { projectId: 'proj-a', projectName: '咕咕', sessionIds: ['s-1', 's-2'] }

function seedGroup(chatId: string, options: Partial<Pick<FakeGroup, 'status' | 'kind'>> & { members?: string[] } = {}): FakeGroup {
  const group: FakeGroup = {
    chatId,
    kind: options.kind ?? 'group',
    status: options.status ?? 'active',
    members: new Map((options.members ?? [OWNER]).map((id) => [id, { listen_mode: 'active' }])),
  }
  groups.set(chatId, group)
  return group
}

function seedAgent(agentUserId: string, sessionId: string, cache: Record<string, unknown> = {}): RosterRec {
  const rec: RosterRec = {
    id: `rec-${agentUserId}`,
    name: agentUserId,
    agent_type: 'codex',
    gugu_user_id: agentUserId,
    cache: {
      emdash_session_id: sessionId,
      emdash_project_id: 'proj-a',
      sessionpage_owner_user_id: OWNER,
      ...cache,
    },
  }
  roster.push(rec)
  return rec
}

const pinOf = (agentUserId: string): unknown => roster.find((r) => r.gugu_user_id === agentUserId)?.cache?.sessionpage_group_chat_id

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-project-group-binding-'))
  env = { GUGU_HOME: home } as NodeJS.ProcessEnv
  signedIn = true
  roster.length = 0
  groups.clear()
  rpcCalls.length = 0
  memberUpdates.length = 0
  chatUpdates.length = 0
  addGroupAgent = () => ({ data: { status: 'joined' }, error: null })
  beforeCreateGroup = null
  const { resetSessionpageCloudProvisioningForTests } = await import(PROVISIONING)
  resetSessionpageCloudProvisioningForTests()
})
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true })
  home = ''
})

describe('读绑定', () => {
  it('对照里记着的 + 老数据只记在名册上的;只答问到的项目,隐式项目不算', async () => {
    const { rememberProjectGroupId } = await import(MAPPING)
    await rememberProjectGroupId('proj-a', 'chat-a', OWNER, env)
    await rememberProjectGroupId('proj-gone', 'chat-gone', OWNER, env)
    await rememberProjectGroupId('proj-other-account', 'chat-x', 'owner-2', env)
    seedAgent('agent-legacy', 's-9', { emdash_project_id: 'proj-legacy', sessionpage_group_chat_id: 'chat-legacy' })
    const host = await makeHost()
    const result = await host.listBindings(['proj-a', 'proj-legacy', 'proj-other-account', 'proj-none', IMPLICIT_PROJECT])
    expect(result).toEqual({
      success: true,
      data: [
        { projectId: 'proj-a', chatId: 'chat-a' },
        { projectId: 'proj-legacy', chatId: 'chat-legacy' },
      ],
    })
  })

  it('云电脑上没有项目群 ⇒ 空;没登录 ⇒ not-signed-in(❌ 冒充空)', async () => {
    const { rememberProjectGroupId } = await import(MAPPING)
    await rememberProjectGroupId('proj-a', 'chat-a', OWNER, env)
    expect(await (await makeHost({ GUGU_CLOUD_COMPUTER: '1' })).listBindings(['proj-a'])).toEqual({ success: true, data: [] })
    signedIn = false
    expect(await (await makeHost()).listBindings(['proj-a'])).toMatchObject({ success: false, error: { type: 'not-signed-in' } })
  })
})

describe('建群(建项目即建群,gugu-dev#181)', () => {
  it('第一次在云端建一个只有群主的群并记进对照;再问还是它,不再建', async () => {
    const host = await makeHost()
    const first = await host.ensureGroup(subjectA)
    expect(first).toMatchObject({ success: true, data: { changed: true } })
    const chatId = (first as { data: { chatId: string } }).data.chatId
    expect(chatId).toMatch(/^[0-9a-f-]{36}$/)
    const { readProjectGroupId } = await import(MAPPING)
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe(chatId)
    expect(await host.ensureGroup(subjectA)).toEqual({ success: true, data: { chatId, changed: false } })
    const created = rpcCalls.filter((c) => c.name === 'create_gugu_group')
    expect(created).toHaveLength(1)
    expect(created[0]!.args).toMatchObject({ p_chat_id: chatId, p_owner_user_id: OWNER, p_initial_members: [] })
    expect([...groups.get(chatId)!.members.keys()]).toEqual([OWNER])
  })

  it('对照里是老版本预留、云端还没建的群 ⇒ 就按那个 id 建', async () => {
    const { rememberProjectGroupId } = await import(MAPPING)
    await rememberProjectGroupId('proj-a', 'chat-reserved', OWNER, env)
    expect(await (await makeHost()).ensureGroup(subjectA)).toEqual({ success: true, data: { chatId: 'chat-reserved', changed: false } })
    expect(groups.get('chat-reserved')?.members.has(OWNER)).toBe(true)
  })

  it('同时问两次 ⇒ 同一个群(与开会话同一把锁,❌ 各记各的)', async () => {
    const host = await makeHost()
    const [a, b] = await Promise.all([host.ensureGroup(subjectA), host.ensureGroup(subjectA)])
    expect((a as { data: { chatId: string } }).data.chatId).toBe((b as { data: { chatId: string } }).data.chatId)
  })

  it('开会话的那一发还在锁里 ⇒ 等它放锁再读写对照', async () => {
    const { serializeProvisionForTest } = await import(PROVISIONING)
    const { rememberProjectGroupId } = await import(MAPPING)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    // 替身:锁里那条会话把群记进对照(就像第一个会话做的那样),然后才放锁。
    const provisioning = serializeProvisionForTest(async () => {
      await gate
      await rememberProjectGroupId('proj-a', 'chat-from-first-session', OWNER, env)
    })
    const host = await makeHost()
    const ensured = host.ensureGroup(subjectA)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await provisioning
    expect(await ensured, '排在那条会话后面 ⇒ 认它记下的群,❌ 另起一个').toMatchObject({
      success: true,
      data: { chatId: 'chat-from-first-session' },
    })
  })

  it('对照里的群已归档 ⇒ 另起一个,对照改指它', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    seedGroup('chat-archived', { status: 'archived' })
    await rememberProjectGroupId('proj-a', 'chat-archived', OWNER, env)
    const result = await (await makeHost()).ensureGroup(subjectA)
    const chatId = (result as { data: { chatId: string } }).data.chatId
    expect(chatId).not.toBe('chat-archived')
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe(chatId)
  })

  it('云电脑上的项目不建群:拒绝,对照不动', async () => {
    const result = await (await makeHost({ GUGU_CLOUD_COMPUTER: '1' })).ensureGroup(subjectA)
    expect(result).toMatchObject({ success: false, error: { type: 'not-found' } })
    const { listProjectGroupIds } = await import(MAPPING)
    expect(await listProjectGroupIds(OWNER, env)).toEqual([])
  })
})

describe('并进来(owner 2026-10-17 选 A)', () => {
  it('这个项目的 agent 都加进那个群(座位就是加人给的那一档);对照与名册改指它;原来的群不动,作为 previousChatId 回来', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    const old = seedGroup('chat-old', { members: [OWNER, 'agent-1', 'agent-2'] })
    seedGroup('chat-target')
    await rememberProjectGroupId('proj-a', 'chat-old', OWNER, env)
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    seedAgent('agent-2', 's-2', { sessionpage_group_chat_id: 'chat-old' })
    // 归档了的会话的 agent、别的账号停放在这里的行:都不是这个项目此刻的 agent。
    seedAgent('agent-archived', 's-archived', { sessionpage_group_chat_id: 'chat-old' })
    seedAgent('agent-foreign', 's-1', { sessionpage_owner_user_id: 'owner-2', sessionpage_group_chat_id: 'chat-old' })

    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-target')

    expect(result).toEqual({ success: true, data: { movedAgents: 2, previousChatId: 'chat-old', changed: true } })
    expect(rpcCalls.filter((c) => c.name === 'add_group_agent').map((c) => c.args.p_agent_user_id)).toEqual(['agent-1', 'agent-2'])
    // 项目里的 agent 是任务 agent:补进项目群坐任务座位(主动、不发入群提示),❌ 进群之后再补一道改档位。
    expect(rpcCalls.filter((c) => c.name === 'add_group_agent').every((c) => c.args.p_as_task === true)).toBe(true)
    expect(rpcCalls.some((c) => c.name === 'set_agent_listen_mode_as')).toBe(false)
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe('chat-target')
    expect(pinOf('agent-1')).toBe('chat-target')
    expect(pinOf('agent-2')).toBe('chat-target')
    expect(roster.find((r) => r.gugu_user_id === 'agent-1')?.cache?.sessionpage_group_chat_before_bind).toBe('chat-old')
    expect(pinOf('agent-archived'), '不是这个项目此刻的 agent ⇒ 不动').toBe('chat-old')
    expect(pinOf('agent-foreign'), '别的账号的行不动').toBe('chat-old')
    expect(chatUpdates, '原来的群不归档').toEqual([])
    expect([...old.members.keys()], '原来的群一个人都不少').toEqual([OWNER, 'agent-1', 'agent-2'])
  })

  it('已经绑在那个群上 ⇒ 原样返回:movedAgents 0、previousChatId null、没改东西', async () => {
    seedGroup('chat-target')
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    const host = await makeHost()
    await host.bindToGroup(subjectA, 'chat-target')
    const again = await host.bindToGroup(subjectA, 'chat-target')
    expect(again).toEqual({ success: true, data: { movedAgents: 0, previousChatId: null, changed: false } })
  })

  it.each([
    { label: '已归档', group: { status: 'archived' as const } },
    { label: '不是群', group: { kind: 'dm' as const } },
    { label: '当前账号不在里面', group: { members: ['someone-else'] } },
  ])('那个群不能用($label)⇒ group-unavailable,对照与名册都不动、不往里加人', async ({ group }) => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    seedGroup('chat-bad', group)
    await rememberProjectGroupId('proj-a', 'chat-old', OWNER, env)
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-bad')
    expect(result).toMatchObject({ success: false, error: { type: 'group-unavailable', chatId: 'chat-bad' } })
    expect(rpcCalls).toEqual([])
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe('chat-old')
    expect(pinOf('agent-1')).toBe('chat-old')
  })

  it('那个群是老版本另一台机器预留的、云端还没建 ⇒ 按那个 id 建一个只有群主的群,再和已有的群一样加人', async () => {
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-reserved-on-a')
    // 名册钉着的 chat-old 云端从没建出来(预留了、没落地)⇒ 没有「原来的群」可留作历史。
    expect(result).toMatchObject({ success: true, data: { movedAgents: 1, previousChatId: null } })
    expect(rpcCalls.map((c) => c.name)).toEqual(['create_gugu_group', 'add_group_agent'])
    expect(rpcCalls[0]!.args).toMatchObject({ p_chat_id: 'chat-reserved-on-a', p_name: '咕咕', p_owner_user_id: OWNER, p_initial_members: [] })
    expect(pinOf('agent-1')).toBe('chat-reserved-on-a')
  })

  it('预留的群、这边也还没有 agent ⇒ 建出只有群主的群,记下对照', async () => {
    const { readProjectGroupId } = await import(MAPPING)
    const result = await (await makeHost()).bindToGroup({ ...subjectA, sessionIds: [] }, 'chat-reserved-on-a')
    expect(result).toEqual({ success: true, data: { movedAgents: 0, previousChatId: null, changed: true } })
    expect(rpcCalls.map((c) => c.name)).toEqual(['create_gugu_group'])
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe('chat-reserved-on-a')
  })

  it('预留的 id 刚被那台机器的第一个会话建出来(撞主键)⇒ 按已有的群加人,❌ 报群不能用', async () => {
    seedAgent('agent-1', 's-1')
    beforeCreateGroup = (chatId) => {
      if (chatId === 'chat-raced') seedGroup('chat-raced')
    }
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-raced')
    expect(result).toMatchObject({ success: true, data: { movedAgents: 1 } })
    expect(rpcCalls.map((c) => c.name), '建群撞主键之后走了「加人」那一支').toEqual(['create_gugu_group', 'add_group_agent'])
    expect(pinOf('agent-1')).toBe('chat-raced')
  })

  it('预留的 id 撞上一个这个账号看不见的群 ⇒ group-unavailable,对照不改', async () => {
    const { readProjectGroupId } = await import(MAPPING)
    seedAgent('agent-1', 's-1')
    beforeCreateGroup = (chatId) => {
      if (chatId === 'chat-foreign') seedGroup('chat-foreign', { members: ['someone-else'] })
    }
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-foreign')
    expect(result).toMatchObject({ success: false, error: { type: 'group-unavailable', chatId: 'chat-foreign' } })
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBeNull()
  })

  it('公网身份还没落地的 agent:不往群里加(云端还没有它),名册钉上这个群 —— 它落地时带着这个群进来', async () => {
    seedGroup('chat-target')
    seedAgent('agent-ready', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    seedAgent('agent-pending', 's-2', { sessionpage_group_chat_id: 'chat-old', sessionpage_cloud_identity_state: 'failed' })
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-target')
    expect(result).toMatchObject({ success: true, data: { movedAgents: 2 } })
    expect(rpcCalls.filter((c) => c.name === 'add_group_agent').map((c) => c.args.p_agent_user_id)).toEqual(['agent-ready'])
    expect(pinOf('agent-pending')).toBe('chat-target')
  })

  it('群要审批 ⇒ 那个 agent 这次没进群,名册照旧钉着原来的群、不算搬过去', async () => {
    seedGroup('chat-target')
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    addGroupAgent = () => ({ data: { status: 'pending_approval', request_id: 'req-1' }, error: null })
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-target')
    expect(result).toMatchObject({ success: true, data: { movedAgents: 0 } })
    expect(pinOf('agent-1')).toBe('chat-old')
    expect(memberUpdates, '没进群就不改它的收听方式').toEqual([])
  })

  it('加人失败 ⇒ cloud-failed,对照不改(再并一次是幂等的)', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    seedGroup('chat-target')
    await rememberProjectGroupId('proj-a', 'chat-old', OWNER, env)
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    addGroupAgent = () => ({ error: { message: 'member_limit_reached' } })
    const result = await (await makeHost()).bindToGroup(subjectA, 'chat-target')
    expect(result).toMatchObject({ success: false, error: { type: 'cloud-failed' } })
    expect((result as { error: { message: string } }).error.message).toContain('member_limit_reached')
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe('chat-old')
    expect(pinOf('agent-1')).toBe('chat-old')
  })

  it('云电脑上的项目 ⇒ 拒绝并入', async () => {
    seedGroup('chat-target')
    const result = await (await makeHost({ GUGU_CLOUD_COMPUTER: '1' })).bindToGroup(subjectA, 'chat-target')
    expect(result).toMatchObject({ success: false, error: { type: 'group-unavailable', chatId: 'chat-target' } })
    expect(rpcCalls).toEqual([])
  })
})

describe('撤销', () => {
  it('解除最初建群的设备也清除名册兜底,原群成员与历史仍保留', async () => {
    const { rememberProjectGroupId } = await import(MAPPING)
    const group = seedGroup('chat-shared', { members: [OWNER, 'agent-1'] })
    await rememberProjectGroupId('proj-a', 'chat-shared', OWNER, env)
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-shared' })
    const host = await makeHost()
    expect(await host.unbind(subjectA)).toMatchObject({ success: true, data: { changed: true } })
    expect(await host.listBindings(['proj-a'])).toEqual({ success: true, data: [] })
    expect(group.members.has('agent-1')).toBe(true)
    expect(await host.unbind(subjectA)).toEqual({ success: true, data: { changed: false, expectedChatId: null } })
  })
  it('恢复解除关联前的群,拒绝旧 undo 覆盖后来换过的群,重复恢复幂等', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    seedGroup('chat-shared')
    await rememberProjectGroupId('proj-a', 'chat-newer', OWNER, env)
    const host = await makeHost()
    expect(await host.bindToGroup(subjectA, 'chat-shared', null)).toMatchObject({ success: false, error: { message: expect.stringContaining('已更改') } })
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe('chat-newer')
    expect(await host.bindToGroup(subjectA, 'chat-shared', 'chat-newer')).toMatchObject({ success: true })
    expect(await host.bindToGroup(subjectA, 'chat-shared', 'chat-newer')).toMatchObject({ success: true, data: { changed: false } })
  })
  it('忘掉对照,agent 在名册里钉回并进来之前的群;已经进了那个群的不踢出来', async () => {
    const { rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    seedGroup('chat-old', { members: [OWNER, 'agent-1'] })
    const target = seedGroup('chat-target')
    await rememberProjectGroupId('proj-a', 'chat-old', OWNER, env)
    seedAgent('agent-1', 's-1', { sessionpage_group_chat_id: 'chat-old' })
    const host = await makeHost()
    await host.bindToGroup(subjectA, 'chat-target')
    rpcCalls.length = 0

    expect(await host.unbind(subjectA)).toEqual({ success: true, data: { changed: true, expectedChatId: 'chat-old' } })
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBeNull()
    expect(pinOf('agent-1'), '钉回原来的群:下一条会话照名册找群就回到那里').toBe('chat-old')
    expect(roster[0]!.cache).not.toHaveProperty('sessionpage_group_chat_before_bind')
    expect(target.members.has('agent-1'), '已经加进去的 agent 留在那个群里').toBe(true)
    expect(rpcCalls).toEqual([])
    // 名册回到原来的群之后,读绑定退回名册 —— 正是撤销想要的那个群。
    expect(await host.listBindings(['proj-a'])).toEqual({ success: true, data: [{ projectId: 'proj-a', chatId: 'chat-old' }] })
  })

  it('没绑过 ⇒ 什么都不改', async () => {
    expect(await (await makeHost()).unbind(subjectA)).toEqual({ success: true, data: { changed: false, expectedChatId: null } })
  })
})

describe('操作 agent 的项目群公告权限', () => {
  const auth = { accessToken: 'token', userId: OWNER }
  const project = { projectId: 'proj-new', projectName: 'New', chatId: 'chat-new' }
  it('用当前 agent 建出预留群,保留它原来所在的项目和群', async () => {
    const agent = seedAgent('caller', 'other-session', { sessionpage_group_chat_id: 'chat-original' })
    const before = structuredClone(agent)
    const { ensureProjectNoticeAccess } = await import(SUT)
    await ensureProjectNoticeAccess(auth, 'caller', project)
    expect(groups.get('chat-new')?.members.has('caller')).toBe(true)
    expect(agent).toEqual(before)
    expect(memberUpdates).toEqual([])
  })
  // gugu-dev#181:建项目的 agent 补进已有的项目群,坐任务座位(主动、不发入群提示)。
  it('the founding agent joins an existing project group in a task seat', async () => {
    seedGroup('chat-new')
    const { ensureProjectNoticeAccess } = await import(SUT)
    await ensureProjectNoticeAccess(auth, 'caller', project, { founding: true })
    expect(rpcCalls.filter((call) => call.name === 'add_group_agent').map((call) => call.args)).toEqual([
      { p_chat_id: 'chat-new', p_agent_user_id: 'caller', p_message: null, p_as_user_id: OWNER, p_as_task: true },
    ])
    expect(groups.get('chat-new')?.members.get('caller')?.listen_mode).toBe('active')
  })
  it('an existing member may announce repeatedly without any join mutation', async () => {
    seedGroup('chat-new', { members: [OWNER, 'caller'] })
    const { ensureProjectNoticeAccess } = await import(SUT)
    await ensureProjectNoticeAccess(auth, 'caller', project)
    await ensureProjectNoticeAccess(auth, 'caller', project)
    expect(rpcCalls.filter((call) => call.name === 'add_group_agent')).toHaveLength(0)
  })
  it('an absent Agent is not silently re-added, including while approval is pending', async () => {
    seedGroup('chat-new')
    addGroupAgent = () => ({ data: { status: 'pending_approval' }, error: null })
    const { ensureProjectNoticeAccess } = await import(SUT)
    await expect(ensureProjectNoticeAccess(auth, 'caller', project)).rejects.toThrow('明确重新加入')
    expect(rpcCalls.filter((call) => call.name === 'add_group_agent')).toHaveLength(0)
  })
  it('建项目的 agent(founding):项目群建项目时就有了、只有群主 ⇒ 它在这里入座,再发群通知', async () => {
    seedGroup('chat-new')
    const { ensureProjectNoticeAccess } = await import(SUT)
    await ensureProjectNoticeAccess(auth, 'caller', project, { founding: true })
    expect(rpcCalls.filter((call) => call.name === 'add_group_agent').map((call) => call.args.p_agent_user_id)).toEqual(['caller'])
    expect(groups.get('chat-new')?.members.has('caller')).toBe(true)
  })
  it('founding 也不越过审批:群要审批 ⇒ 如实报错', async () => {
    seedGroup('chat-new')
    addGroupAgent = () => ({ data: { status: 'pending_approval' }, error: null })
    const { ensureProjectNoticeAccess } = await import(SUT)
    await expect(ensureProjectNoticeAccess(auth, 'caller', project, { founding: true })).rejects.toThrow('需审批')
  })
})

describe('对照变了就叫一声(渲染层据此重读绑定)', () => {
  it('真写了才叫:记新的、改指、忘掉各一次;重复记同一个、忘一个没有的不叫', async () => {
    const { onProjectGroupMappingChanged, rememberProjectGroupId, forgetProjectGroupId } = await import(MAPPING)
    const heard: Array<{ projectId: string; ownerUserId: string }> = []
    const off = onProjectGroupMappingChanged((change: { projectId: string; ownerUserId: string }) => heard.push(change))
    try {
      await rememberProjectGroupId('proj-a', 'chat-1', OWNER, env)
      await rememberProjectGroupId('proj-a', 'chat-1', OWNER, env)
      await rememberProjectGroupId('proj-a', 'chat-2', OWNER, env)
      await forgetProjectGroupId('proj-a', OWNER, env)
      await forgetProjectGroupId('proj-a', OWNER, env)
    } finally {
      off()
    }
    expect(heard).toEqual([
      { projectId: 'proj-a', ownerUserId: OWNER },
      { projectId: 'proj-a', ownerUserId: OWNER },
      { projectId: 'proj-a', ownerUserId: OWNER },
    ])
  })

  it('听的人出错不把写入变成失败', async () => {
    const { onProjectGroupMappingChanged, rememberProjectGroupId, readProjectGroupId } = await import(MAPPING)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = onProjectGroupMappingChanged(() => { throw new Error('listener broke') })
    try {
      await rememberProjectGroupId('proj-a', 'chat-1', OWNER, env)
    } finally {
      off()
      spy.mockRestore()
    }
    expect(await readProjectGroupId('proj-a', OWNER, env)).toBe('chat-1')
  })
})
