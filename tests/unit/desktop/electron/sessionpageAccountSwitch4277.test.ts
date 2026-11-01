import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #6396 铸身份会在后台补取名字序号账本。这里不测它,截断适配器免得真去连库。
vi.mock('@gugu/core/cloud/agentIdentityReconcile', () => ({
  listAgentNameSerialsViaSupabase: vi.fn(async () => new Map()),
}))

// #4277 owner 拍板(2026-09-04):**会话不带账号;起 agent 那一刻读当下登录的是谁,就以它跑;这个账号还
// 没登记过(agent / 项目群)就当场登记一次。** 会话本体像文件夹归设备,行动身份归当下登录。
//
// 落到 provisioning 上就是一句:按(会话, 当前账号)找名册行。命中别家的行 ⇒ 停放(绑定挪到 parked
// 格、摘投递注册),再找自己停放过的行恢复;都没有 ⇒ 为当前账号新登记。停放不删任何东西,A、B 来回切
// 各用各的 agent。这些断言写在**可观测的结果**上:名册里哪一行绑着会话、谁被摘了注册、云端建了谁的群。

const SUT = '../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning'

interface RosterRec {
  id: string
  name: string
  agent_type: string
  gugu_user_id: string
  cache?: Record<string, unknown> | null
}

const roster: RosterRec[] = []
const groups: Array<{ chatId: string; ownerUserId: string; members: string[] }> = []
/** 当前账号在云端看得见的群(RLS 的假边界:别家的群 maybeSingle 回 null)。 */
let visibleGroups = new Set<string>()
const tombstoneLookups: Array<{ sessionId: string; ownerUserId: string | undefined }> = []
/** 一次往返 RPC 铸出的 agent id,按铸出顺序。 */
const minted: string[] = []

vi.mock('@gugu/core', () => ({
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
    return { ...rec }
  }),
  writeAgentRuntimeSession: vi.fn(async () => undefined),
  listReapedAgentsForSession: vi.fn(async (sessionId: string, _env: unknown, ownerUserId?: string) => {
    tombstoneLookups.push({ sessionId, ownerUserId })
    return []
  }),
}))

vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseUrl: () => 'http://127.0.0.1:55321',
  getSupabaseAnonKey: () => 'anon-public-not-a-secret',
}))

vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  // #5331 供给链改走 Chromium 连接池;单测里没有 electron,留 undefined ⇒ 退回全局 fetch。
  electronFetch: undefined,
  makeChatClient: () => ({
    from: (table: string) => {
      let lookedUpId = ''
      const chain = {
        insert: async () => ({ error: null }),
        update: () => chain,
        select: () => chain,
        in: () => chain,
        limit: () => chain,
        eq: (column: string, value: string) => {
          if (table === 'chats' && column === 'id') lookedUpId = value
          return chain
        },
        maybeSingle: async () => ({
          data: lookedUpId && visibleGroups.has(lookedUpId) ? { id: lookedUpId } : null,
          error: null,
        }),
        then: (resolve: (v: { data: never[]; error: null }) => unknown) => resolve({ data: [], error: null }),
      }
      return chain
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'create_gugu_group') {
        const chatId = String(args.p_chat_id)
        groups.push({
          chatId,
          ownerUserId: String(args.p_owner_user_id),
          members: (args.p_initial_members as Array<{ user_id: string }>).map((m) => m.user_id),
        })
        visibleGroups.add(chatId)
        return { data: null, error: null }
      }
      return { data: null, error: null }
    },
  }),
}))

const registryUnregistered: string[] = []
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-registry', () => ({
  registerEmdashAgent: vi.fn(),
  emdashAgentRegistry: { unregister: (id: string) => { registryUnregistered.push(id) } },
}))

const deliveryUnregistered: Array<{ agentUserId: string; sessionId?: string }> = []
vi.mock('../../../../apps/desktop/electron/sessionpage/local-session-delivery', () => ({
  registerOfflineLocalSessionDelivery: vi.fn(),
  unregisterLocalSessionDeliveryForAgent: (agentUserId: string, sessionId?: string) => {
    deliveryUnregistered.push({ agentUserId, sessionId })
  },
}))

const deliveryClaims: Array<{ guguAgentUserId: string; sessionId: string }> = []
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry', () => ({
  prepareSessionpageDeliveryOwner: async (
    _ownerKind: string,
    registration: { guguAgentUserId: string; sessionId: string },
  ) => {
    deliveryClaims.push({ guguAgentUserId: registration.guguAgentUserId, sessionId: registration.sessionId })
  },
  unregisterSessionpageDeliveryOwners: vi.fn(async () => undefined),
}))

let home = ''
let currentOwner = 'owner-A'
let ownershipProbe: ((agentUserId: string) => Promise<boolean>) | undefined
/**
 * identity.provision_taskpage_agent 的假服务端:收下客户端预生成的 agent id;映射里那个群当前账号看得见 ⇒
 * 加座位;看不见(别家的群,RLS 之外)⇒ 用新 id 另建;不存在 ⇒ 就用映射里那个 id 建。
 */
async function fakeProvisionOneTrip(input: {
  agentId: string
  displayName: string
  groupName?: string | null
  priorGroupChatId?: string | null
  newGroupChatId?: string | null
}) {
  minted.push(input.agentId)
  const reply = { agentId: input.agentId, displayName: input.displayName, groupCreated: false }
  if (!input.groupName || !input.priorGroupChatId) return { ...reply, groupChatId: '', priorGroupState: 'none' }
  const prior = groups.find((g) => g.chatId === input.priorGroupChatId)
  if (prior && visibleGroups.has(prior.chatId)) {
    prior.members.push(input.agentId)
    return { ...reply, groupChatId: prior.chatId, priorGroupState: 'active' }
  }
  const chatId = prior ? String(input.newGroupChatId) : input.priorGroupChatId
  groups.push({ chatId, ownerUserId: currentOwner, members: [currentOwner, input.agentId] })
  visibleGroups.add(chatId)
  return { ...reply, groupChatId: chatId, groupCreated: true, priorGroupState: prior ? 'foreign' : 'missing' }
}
const deps = {
  getAuth: async () => ({ accessToken: `token-${currentOwner}`, refreshToken: 'refresh', userId: currentOwner }),
  resolveDeviceId: async () => 'device-1',
  provisionOneTrip: fakeProvisionOneTrip,
  get isAgentOwnedByCurrentUser() {
    return ownershipProbe
  },
  get env(): NodeJS.ProcessEnv {
    return { GUGU_HOME: home } as NodeJS.ProcessEnv
  },
}

const SESSION = 'conv-shared'
const PROJECT = 'proj-1'
const SESSION_NAME = 'Codex 1'

async function openSession(overrides: Record<string, unknown> = {}) {
  const { provisionSessionpageAgentForSession, settleSessionpageCloudProvisioning } = await import(SUT)
  const provisioned = await provisionSessionpageAgentForSession(
    {
      sessionId: SESSION,
      providerId: 'codex',
      surface: 'tui',
      cwd: '/w/shared',
      projectId: PROJECT,
      // The session was named once at creation and carries that name whichever account opens it.
      displayName: SESSION_NAME,
      ...overrides,
    },
    deps,
  )
  if (!provisioned) throw new Error('这条会话必须拿到身份')
  await settleSessionpageCloudProvisioning()
  return provisioned
}

function activeRow(): RosterRec | undefined {
  return roster.find((r) => r.cache?.['emdash_session_id'] === SESSION)
}
function parkedRows(): RosterRec[] {
  return roster.filter((r) => r.cache?.['sessionpage_parked_session_id'] === SESSION)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-account-switch-4277-'))
  roster.length = 0
  groups.length = 0
  visibleGroups = new Set()
  tombstoneLookups.length = 0
  registryUnregistered.length = 0
  deliveryUnregistered.length = 0
  deliveryClaims.length = 0
  minted.length = 0
  currentOwner = 'owner-A'
  ownershipProbe = undefined
  vi.clearAllMocks()
})

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true })
  home = ''
})

describe('#4277 会话不带账号:起 agent 时按当下登录的账号找/登记', () => {
  it('A 建的会话 B 打开 → A 的行停放、B 得到自己的 agent 与自己的项目群', async () => {
    const asA = await openSession()
    expect(asA.guguAgentUserId).toBe(minted[0])
    expect(activeRow()?.cache?.['sessionpage_owner_user_id']).toBe('owner-A')
    expect(groups.map((g) => g.ownerUserId)).toEqual(['owner-A'])

    // B 登录:RLS 下 A 的群对 B 不可见。
    currentOwner = 'owner-B'
    visibleGroups = new Set()
    const asB = await openSession()

    expect(asB.guguAgentUserId, 'B 不借 A 的 agent').toBe(minted[1])
    expect(asB.guguAgentUserId).not.toBe(asA.guguAgentUserId)
    expect(activeRow()?.gugu_user_id, '会话现在绑在 B 的行上').toBe(asB.guguAgentUserId)
    expect(activeRow()?.cache?.['sessionpage_owner_user_id']).toBe('owner-B')
    expect(parkedRows().map((r) => r.gugu_user_id), 'A 的行没删,只是停放').toEqual([asA.guguAgentUserId])
    expect(roster[0].cache?.['emdash_session_id'], '停放的行不再持有活动绑定').toBeUndefined()
    expect(registryUnregistered, '停放要摘掉 A 的 registry 项').toEqual([asA.guguAgentUserId])
    expect(deliveryUnregistered, '停放要摘掉 A 的投递注册').toEqual([{ agentUserId: asA.guguAgentUserId, sessionId: SESSION }])
    expect(groups.map((g) => g.ownerUserId), 'B 在同一项目有自己的群(A 的群 B 进不去)').toEqual(['owner-A', 'owner-B'])
    expect(deliveryClaims.at(-1), 'B 的 agent 接管投递归属').toEqual({ guguAgentUserId: asB.guguAgentUserId, sessionId: SESSION })
  })

  it('A 回来 → 恢复 A 停放的行,不再铸第二个 agent;B 的行轮到停放', async () => {
    const asA = await openSession()
    currentOwner = 'owner-B'
    visibleGroups = new Set()
    const asB = await openSession()
    registryUnregistered.length = 0

    currentOwner = 'owner-A'
    visibleGroups = new Set(groups.filter((g) => g.ownerUserId === 'owner-A').map((g) => g.chatId))
    const back = await openSession()

    expect(back.guguAgentUserId, 'A 拿回自己原来的 agent').toBe(asA.guguAgentUserId)
    expect(minted, '来回切换不铸新身份').toHaveLength(2)
    expect(activeRow()?.gugu_user_id).toBe(asA.guguAgentUserId)
    expect(parkedRows().map((r) => r.gugu_user_id)).toEqual([asB.guguAgentUserId])
    expect(registryUnregistered).toEqual([asB.guguAgentUserId])
    expect(back.projectContext?.groupChatId, 'A 的群还是原来那个').toBe(groups[0].chatId)
  })

  it('老行没记 owner:探针说不归我 → 停放并新登记;探针说归我 → 复用并补上 owner', async () => {
    roster.push({
      id: 'rec-legacy', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'agent-legacy',
      cache: { emdash_session_id: SESSION, emdash_project_id: PROJECT, sessionpage_group_chat_id: 'g-legacy',
        sessionpage_provider_id: 'codex', sessionpage_session_surface: 'tui' },
    })

    ownershipProbe = async () => false
    const stranger = await openSession()
    expect(stranger.guguAgentUserId).toBe(minted[0])
    expect(parkedRows().map((r) => r.gugu_user_id)).toEqual(['agent-legacy'])

    // 真正的主人回来:它的老行在停放区、仍然没记 owner ⇒ 靠探针认回来并补上 owner。
    currentOwner = 'owner-legacy'
    ownershipProbe = async (agentUserId) => agentUserId === 'agent-legacy'
    visibleGroups = new Set(['g-legacy'])
    const rightful = await openSession()
    expect(rightful.guguAgentUserId).toBe('agent-legacy')
    expect(activeRow()?.cache?.['sessionpage_owner_user_id']).toBe('owner-legacy')
    expect(minted, '认回老行,不铸新的').toHaveLength(1)
  })

  it('没有探针(单账号机器的老行为)→ 老行按「归我」认领并补上 owner', async () => {
    roster.push({
      id: 'rec-legacy', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'agent-legacy',
      cache: { emdash_session_id: SESSION, emdash_project_id: PROJECT, sessionpage_group_chat_id: 'g-legacy',
        sessionpage_provider_id: 'codex', sessionpage_session_surface: 'tui' },
    })
    visibleGroups = new Set(['g-legacy'])
    const reused = await openSession()
    expect(reused.guguAgentUserId).toBe('agent-legacy')
    expect(activeRow()?.cache?.['sessionpage_owner_user_id']).toBe('owner-A')
    expect(minted).toHaveLength(0)
  })

  it('探针查询出错 → 抛出,不把自己的 agent 当别家的停放掉', async () => {
    roster.push({
      id: 'rec-legacy', name: 'Codex 1', agent_type: 'codex', gugu_user_id: 'agent-legacy',
      cache: { emdash_session_id: SESSION, sessionpage_provider_id: 'codex', sessionpage_session_surface: 'tui' },
    })
    ownershipProbe = async () => { throw new Error('identity lookup failed') }
    await expect(openSession()).rejects.toThrow('identity lookup failed')
    expect(activeRow()?.gugu_user_id, '行原样留着').toBe('agent-legacy')
    expect(parkedRows()).toEqual([])
    expect(minted).toHaveLength(0)
  })

  it('墓碑按(会话, 当前账号)查:A 删过自己的 agent 不挡 B 登记', async () => {
    currentOwner = 'owner-B'
    await openSession()
    expect(tombstoneLookups).toEqual([{ sessionId: SESSION, ownerUserId: 'owner-B' }])
  })

  it('项目群映射按账号分区落盘:两个账号各记各的', async () => {
    await openSession()
    currentOwner = 'owner-B'
    visibleGroups = new Set()
    await openSession()

    const mapping = JSON.parse(await readFile(join(home, 'taskpage-project-groups.json'), 'utf8')) as {
      owners: Record<string, Record<string, string>>
    }
    expect(mapping.owners['owner-A']?.[PROJECT]).toBe(groups[0].chatId)
    expect(mapping.owners['owner-B']?.[PROJECT]).toBe(groups[1].chatId)
  })
})
