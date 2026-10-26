// gugu-dev#181「派任务」:派出去的任务首句落成那个对话里的一张任务卡(宿主以主人身份写、不叫醒人),
// agent 拿到的第一轮按落点不同:群 = 这个群的投递信封(回群、引用卡);还没进群 = 信封里多一句「回在你自己的会话里」;
// 和人的私聊 = 原话(agent 进不去私聊)。
// OpenDCAI/gugu#446 项目群 = 卡上开一条话题(找或开)、agent 的群座位转 passive、首轮是话题的投递信封。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseComposerCard } from '../../../../packages/core/src/shared/ui/taskCardModels'

const roster = [{ name: 'Claude 7', gugu_user_id: 'agent-7', agent_type: 'claude-code', path: '', prompt: '', created_at: 0 }]
const LOOK = 'https://storage.test/avatars/agent-look/v1/agent-7.json'
const chats = new Map<string, { kind: string; public_id: number | null; name: string | null; members: string[] }>()
const writes: Array<Record<string, unknown>> = []
const awaited: string[] = []
const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
const topics: Array<{ chat_id: string; source_chat_id: string; source_message_id: string }> = []
// 本机「项目 → 群」映射与账号上记着的项目群(identity.device_projects)。
const localProjectGroups = new Map<string, string>()
const accountProjectGroups = new Set<string>()

vi.mock('@gugu/core', () => ({ listAgents: vi.fn(async () => roster) }))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  awaitSessionpageCloudIdentity: vi.fn(async (agentUserId: string) => { awaited.push(agentUserId) }),
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups', () => ({
  readProjectGroupId: vi.fn(async (projectId: string) => localProjectGroups.get(projectId) ?? null),
  listProjectGroupIds: vi.fn(async () => [...localProjectGroups].map(([projectId, chatId]) => ({ projectId, chatId, representative: true }))),
}))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeIdentityClient: () => ({
    from: (table: string) => {
      const filters: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query },
        limit: async () => ({ data: table === 'device_projects' && filters.user_id === 'owner-1' && accountProjectGroups.has(filters.chat_id ?? '') ? [{ local_project_id: 'elsewhere' }] : [], error: null }),
        maybeSingle: async () => ({ data: table === 'users' && filters.id === 'agent-7' ? { avatar: LOOK } : null, error: null }),
      }
      return query
    },
  }),
  makeChatClient: () => ({
    from(table: string) {
      const filters: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query },
        maybeSingle: async () => {
          if (table === 'chats') {
            const chat = chats.get(filters.id ?? '')
            return { data: chat ? { id: filters.id, kind: chat.kind, public_id: chat.public_id, name: chat.name } : null, error: null }
          }
          const chat = chats.get(filters.chat_id ?? '')
          return { data: chat?.members.includes(filters.user_id ?? '') ? { user_id: filters.user_id } : null, error: null }
        },
      }
      return query
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'send_message_idempotent') {
        writes.push(args)
        return { error: null }
      }
      rpcs.push({ name, args })
      if (name === 'set_agent_listen_mode_as') {
        return { data: { chat_id: args.p_chat_id, user_id: args.p_agent_user_id, listen_mode: args.p_mode }, error: null }
      }
      if (name === 'list_topics_of_chat') {
        return { data: topics.filter((topic) => topic.source_chat_id === args.p_source_chat_id), error: null }
      }
      if (name === 'create_topic') {
        const chatId = `00000000-0000-4000-8000-0000000009${String(topics.length + 1).padStart(2, '0')}`
        topics.push({ chat_id: chatId, source_chat_id: args.p_source_chat_id as string, source_message_id: args.p_source_message_id as string })
        chats.set(chatId, { kind: 'topic', public_id: 9000 + topics.length, name: args.p_name as string, members: ['owner-1', ...(args.p_member_user_ids as string[])] })
        return { data: [{ chat_id: chatId }], error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }),
}))

const { landTaskCardFirstTurn, TASK_CARD_NOT_MEMBER_HINT, TASK_CARD_TOPIC_HINT } = await import('../../../../apps/desktop/electron/sessionpage/task-card-first-turn')
const { taskTopicName } = await import('../../../../apps/desktop/electron/sessionpage/task-card-topic')

function land(chatId: string, text = '  登录页闪一下，看看为什么  ') {
  return landTaskCardFirstTurn({
    auth: { accessToken: 'token', userId: 'owner-1' },
    sessionId: 'session-1',
    projectId: 'project-1',
    agentUserId: 'agent-7',
    chatId,
    messageId: '00000000-0000-4000-8000-000000000004',
    text,
    deviceId: 'device-1',
    machineLabel: 'Mac Studio',
    senderIdentities: new Map([['owner-1', { guguNumber: 1001, displayName: '主人' }]]),
    timestamp: '2026-10-22 20:00',
    env: {},
  })
}

beforeEach(() => {
  chats.clear()
  writes.length = 0
  awaited.length = 0
  rpcs.length = 0
  topics.length = 0
  localProjectGroups.clear()
  accountProjectGroups.clear()
})

describe('task card first turn (gugu-dev#181)', () => {
  it('writes the owner\'s card once the identity settled, names nobody, and hands the agent the group envelope', async () => {
    chats.set('00000000-0000-4000-8000-000000000001', { kind: 'group', public_id: 4242, name: '官网', members: ['owner-1', 'agent-7'] })
    const turn = await land('00000000-0000-4000-8000-000000000001')
    expect(awaited).toEqual(['agent-7'])
    expect(writes).toHaveLength(1)
    const write = writes[0]!
    expect(write).toMatchObject({ p_message_id: '00000000-0000-4000-8000-000000000004', p_chat_id: '00000000-0000-4000-8000-000000000001', p_sender_user_id: 'owner-1', p_to_user_ids: [], p_content_type: 'card' })
    expect(parseComposerCard(write.p_content as string)).toEqual({
      v: 1, type: 'task', text: '登录页闪一下，看看为什么', agentUserId: 'agent-7', agentName: 'Claude 7',
      // Who took it, as everyone who sees the card draws it (80e: a colleague could not look the agent up yet).
      agentType: 'claude-code', agentAvatar: LOOK,
      sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'Mac Studio',
    })
    expect(turn.envelope).toBe(true)
    expect(turn.chatId).toBe('00000000-0000-4000-8000-000000000001')
    expect(turn.firstTurn).toContain('msg:00000000-0000-4000-8000-000000000004')
    expect(turn.firstTurn).toContain('登录页闪一下，看看为什么')
    expect(turn.firstTurn).not.toContain(TASK_CARD_NOT_MEMBER_HINT)
    // An ordinary group keeps the agent's seat as it is and opens no topic.
    expect(rpcs).toEqual([])
  })

  it('an agent not in the group yet (approval pending) is told to answer in its own session', async () => {
    chats.set('00000000-0000-4000-8000-000000000002', { kind: 'group', public_id: 7, name: '别人的群', members: ['owner-1'] })
    const turn = await land('00000000-0000-4000-8000-000000000002')
    expect(writes).toHaveLength(1)
    expect(turn.envelope).toBe(true)
    expect(turn.firstTurn).toContain(TASK_CARD_NOT_MEMBER_HINT)
  })

  it('in a direct chat with a person the card stays there and the agent gets the plain words', async () => {
    chats.set('00000000-0000-4000-8000-000000000003', { kind: 'dm', public_id: null, name: null, members: ['owner-1', 'friend-1'] })
    const turn = await land('00000000-0000-4000-8000-000000000003')
    expect(writes).toHaveLength(1)
    expect(turn).toEqual({ chatId: '00000000-0000-4000-8000-000000000003', firstTurn: '登录页闪一下，看看为什么', envelope: false })
  })

  it('fails loud when the chat is not visible to the owner, before writing anything', async () => {
    await expect(land('missing')).rejects.toThrow(/not visible/)
    expect(writes).toHaveLength(0)
  })
})

describe('task card in a project group (OpenDCAI/gugu#446)', () => {
  const GROUP = '00000000-0000-4000-8000-000000000011'
  const TOPIC = '00000000-0000-4000-8000-000000000901'

  it('opens a topic off the card, turns the agent\'s group seat passive, and hands it the topic envelope', async () => {
    chats.set(GROUP, { kind: 'group', public_id: 5151, name: '官网', members: ['owner-1', 'agent-7'] })
    localProjectGroups.set('project-1', GROUP)
    const turn = await land(GROUP, '  登录页闪一下，看看为什么\n先查 CSS  ')
    // The card itself still lands in the group, unchanged.
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ p_chat_id: GROUP, p_content_type: 'card', p_to_user_ids: [] })
    expect(rpcs.map((call) => call.name)).toEqual(['set_agent_listen_mode_as', 'list_topics_of_chat', 'create_topic'])
    expect(rpcs[0]!.args).toEqual({ p_chat_id: GROUP, p_agent_user_id: 'agent-7', p_mode: 'passive', p_as_user_id: 'owner-1' })
    expect(rpcs[2]!.args).toEqual({
      p_source_chat_id: GROUP,
      p_source_message_id: '00000000-0000-4000-8000-000000000004',
      p_name: '登录页闪一下，看看为什么',
      p_member_user_ids: ['agent-7'],
      p_as_user_id: 'owner-1',
    })
    expect(turn.envelope).toBe(true)
    expect(turn.chatId).toBe(TOPIC)
    expect(turn.firstTurn).toContain('chat="9001"')
    expect(turn.firstTurn).toContain('chat_kind="topic"')
    expect(turn.firstTurn).toContain('msg:00000000-0000-4000-8000-000000000004')
    expect(turn.firstTurn).toContain(TASK_CARD_TOPIC_HINT)
    expect(turn.firstTurn).not.toContain('chat="5151"')
  })

  it('a retried spawn finds the topic it opened and does not open a second', async () => {
    chats.set(GROUP, { kind: 'group', public_id: 5151, name: '官网', members: ['owner-1', 'agent-7'] })
    localProjectGroups.set('project-1', GROUP)
    const first = await land(GROUP)
    const second = await land(GROUP)
    expect(second.chatId).toBe(first.chatId)
    expect(topics).toHaveLength(1)
    expect(rpcs.filter((call) => call.name === 'create_topic')).toHaveLength(1)
    expect(rpcs.filter((call) => call.name === 'set_agent_listen_mode_as')).toHaveLength(2)
  })

  it('a group bound to a project on another machine is known from the account\'s project records', async () => {
    chats.set(GROUP, { kind: 'group', public_id: 5151, name: '官网', members: ['owner-1', 'agent-7'] })
    accountProjectGroups.add(GROUP)
    const turn = await land(GROUP)
    expect(turn.chatId).toBe(TOPIC)
  })

  it('an agent without a seat yet keeps today\'s answer-in-your-own-session envelope and gets no topic', async () => {
    chats.set(GROUP, { kind: 'group', public_id: 5151, name: '官网', members: ['owner-1'] })
    localProjectGroups.set('project-1', GROUP)
    const turn = await land(GROUP)
    expect(turn.chatId).toBe(GROUP)
    expect(turn.firstTurn).toContain(TASK_CARD_NOT_MEMBER_HINT)
    expect(rpcs).toEqual([])
  })

  it('names the topic after the task\'s first line, cut like the database cuts a topic name', () => {
    expect(taskTopicName('  修好登录页  \n第二行')).toBe('修好登录页')
    expect(taskTopicName('字'.repeat(41))).toBe(`${'字'.repeat(40)}…`)
    expect(taskTopicName('字'.repeat(40))).toBe('字'.repeat(40))
  })
})
