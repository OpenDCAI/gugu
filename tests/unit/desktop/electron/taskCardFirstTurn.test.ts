// gugu-dev#181「派任务」:派出去的任务首句落成那个对话里的一张任务卡(宿主以主人身份写、不叫醒人),
// agent 拿到的第一轮按落点不同:群 = 这个群的投递信封(回群、引用卡);还没进群 = 信封里多一句「回在你自己的会话里」;
// 和人的私聊 = 原话(agent 进不去私聊)。项目群与普通群同一套:卡在群里、agent 的座位不动、不开话题。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseComposerCard } from '../../../../packages/core/src/shared/ui/taskCardModels'

const roster = [{ name: 'Claude 7', gugu_user_id: 'agent-7', agent_type: 'claude-code', path: '', prompt: '', created_at: 0 }]
const LOOK = 'https://storage.test/avatars/agent-look/v1/agent-7.json'
const chats = new Map<string, { kind: string; public_id: number | null; name: string | null; members: string[] }>()
const writes: Array<Record<string, unknown>> = []
const awaited: string[] = []
const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []

vi.mock('@gugu/core', () => ({ listAgents: vi.fn(async () => roster) }))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  awaitSessionpageCloudIdentity: vi.fn(async (agentUserId: string) => { awaited.push(agentUserId) }),
}))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeIdentityClient: () => ({
    from: (table: string) => {
      const filters: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query },
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
      throw new Error(`unexpected rpc ${name}`)
    },
  }),
}))

const { landTaskCardFirstTurn, TASK_CARD_NOT_MEMBER_HINT } = await import('../../../../apps/desktop/electron/sessionpage/task-card-first-turn')

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
    // A group (project group or not) keeps the agent's seat as it is and opens no topic.
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
