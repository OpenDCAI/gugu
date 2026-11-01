import { currentGroupAdmin } from './groupAdmin'
// 话题(topic)的服务层 —— product spec。
//
// 话题本身就是一条 chat(kind='topic'),所以**发消息、读历史、已读水位、成员管理一律复用现有
// chatService 那套**,这个文件只承担话题特有的三件事:从一条消息开出来、列出一条线上的话题、
// 以及「群里 agent 超过 5 个自动转 passive」那条系统消息背后的撤回台账。
//
// ❌ 不在这里做的事:
//   · 可见性判断 —— 归 RLS(chat.can_see_topic),客户端再判一遍就是第二个属主。
//   · 参与者维护 —— 归数据库触发器(说话/被 @ 当场入列),客户端 ❌ 不许直写 chat_members。
//   · 沉降 —— 纯列表位置,由 last_message_at 派生,不落任何状态位。
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { chatDb, getCurrentAuthUserId } from './supabase'

export type CreateTopicInput = {
  topicId?: string
  sourceChatId: string
  sourceMessageId: string
  /** 不给就由服务端截自来源消息首行前 40 字(spec:名字没人会认真起,不值得为它多一次等待)。 */
  name?: string | null
  /** 开的时候顺手带进来的人/agent。只收来源线里已有的成员,服务端过滤。 */
  memberUserIds?: string[]
}

export type CreatedTopic = {
  chat_id: string
  public_id: number | null
  name: string
  source_chat_id: string
  source_message_id: string
  creator_user_id: string | null
}

type RawCreatedTopic = Partial<Record<keyof CreatedTopic, unknown>>
type RawTopicSummary = Partial<Record<keyof TopicSummary, unknown>>

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** 自动调档台账的一条:界面在它挂着的那条系统消息上画「全部撤回」。 */
export type AgentFloodAdjustment = {
  id: string
  chat_id: string
  message_id: string
  agent_count: number
  changed_count: number
  undone_at: string | null
}

/**
 * 面包屑要区分的三种来源状态。'unreadable' 是 @@@5856 找茬第八轮补上的第三态:
 * 行还在、只是这个人读不到 —— 它既不是 'readable' 也不是 'gone',
 * 把它并进任何一边都会在界面上说一句假话。
 */
export type TopicSourceState =
  | { kind: 'readable'; preview: string }
  | { kind: 'unreadable' }
  | { kind: 'gone' }

export const topicService = {
  /** Archive as the signed-in human; the backend checks source-conversation authority. */
  async archiveTopic(chatId: string): Promise<void> {
    const { data, error } = await chatDb.rpc('archive_topic_as', {
      p_chat_id: chatId,
      p_as_user_id: await getCurrentAuthUserId(),
    })
    if (error) throw new Error(error.message)
    if (data?.chat_id !== chatId || data?.status !== 'archived') {
      throw new Error('archive_topic_as: database did not confirm topic deletion')
    }
  },

  /**
   * 从一条已有消息开一条话题。一步完成 —— ❌ 没有成员勾选、没有可见性开关、没有确认按钮。
   * 必须有来源:服务端校验来源线存在、我在里面、来源消息真属于它,话题上不许再开话题。
   */
  async createTopic(input: CreateTopicInput): Promise<CreatedTopic> {
    const { data, error } = await chatDb.rpc('create_topic', {
      ...(input.topicId ? { p_topic_id: input.topicId } : {}),
      p_source_chat_id: input.sourceChatId,
      p_source_message_id: input.sourceMessageId,
      p_name: input.name?.trim() || null,
      p_member_user_ids: input.memberUserIds?.length ? input.memberUserIds : null,
    })
    if (error) throw new Error(error.message)
    const row = (Array.isArray(data) ? data[0] : data) as RawCreatedTopic | undefined
    const chatId = text(row?.chat_id)
    // fail loud:RPC 回了空行说明来源校验在服务端就没过,❌ 不许静默返回一个假的空话题。
    if (!row || !chatId) throw new Error('create_topic 没有返回话题 —— 来源消息可能已被删除')
    return {
      chat_id: chatId,
      public_id: typeof row.public_id === 'number' ? row.public_id : null,
      name: text(row.name) ?? '话题',
      source_chat_id: text(row.source_chat_id) ?? input.sourceChatId,
      source_message_id: text(row.source_message_id) ?? input.sourceMessageId,
      creator_user_id: text(row.creator_user_id),
    }
  },

  /**
   * 一条线上长出来的全部话题。锚点卡与话题清单共用这一个数据源。
   * 可见继承来源 ⇒ 只要我在来源线里就列得出;是不是参与者由 is_participant 说清,两件事不混。
   */
  async listTopicsOfChat(sourceChatId: string): Promise<TopicSummary[]> {
    const { data, error } = await chatDb.rpc('list_topics_of_chat', { p_source_chat_id: sourceChatId })
    if (error) throw new Error(error.message)
    const rows: TopicSummary[] = []
    for (const raw of (data ?? []) as RawTopicSummary[]) {
      const chatId = text(raw.chat_id)
      const sourceMessageId = text(raw.source_message_id)
      if (!chatId || !sourceMessageId) continue
      rows.push({
        chat_id: chatId,
        name: text(raw.name) ?? '话题',
        source_message_id: sourceMessageId,
        creator_user_id: text(raw.creator_user_id),
        last_message_at: text(raw.last_message_at),
        message_count: Number(raw.message_count ?? 0),
        participant_count: Number(raw.participant_count ?? 0),
        is_participant: raw.is_participant === true,
      })
    }
    return rows
  },

  /**
   * 话题来源的状态(面包屑用)。@@@5856 找茬第八轮:这里原先走 message_reply_preview,
   * 而它返回 0 行有**两种**原因 —— 「真没了」和「行还在、你读不到」。客户端只有两态,
   * 于是把后者显示成「来源消息已被删除」,那是一句假话(消息没被删,别人都看得见)。
   * 现在由服务端把两件事分开(chat.topic_source_state),客户端如实转述。
   */
  async getSourceState(topicChatId: string): Promise<TopicSourceState> {
    const { data, error } = await chatDb.rpc('topic_source_state', { p_topic_chat_id: topicChatId })
    if (error) throw new Error(error.message)
    const row = (Array.isArray(data) ? data[0] : data) as { state?: unknown; preview?: unknown } | undefined
    const state = text(row?.state)
    // 读不到这条话题本身 ⇒ 一行都不回。那时 ❌ 不许下「来源没了」的结论。
    if (state === 'readable') return { kind: 'readable', preview: text(row?.preview) ?? '' }
    if (state === 'gone') return { kind: 'gone' }
    return { kind: 'unreadable' }
  },

  /** 一条群里目前那条「自动转 passive」系统消息对应的台账(没有就是 null)。 */
  async getAgentFloodAdjustment(messageId: string): Promise<AgentFloodAdjustment | null> {
    const { data, error } = await chatDb
      .from('agent_flood_adjustments')
      .select('id, chat_id, message_id, agent_count, changed, undone_at')
      .eq('message_id', messageId)
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    const row = data as Record<string, unknown>
    const id = text(row.id)
    const chatId = text(row.chat_id)
    if (!id || !chatId) return null
    return {
      id,
      chat_id: chatId,
      message_id: messageId,
      agent_count: Number(row.agent_count ?? 0),
      changed_count: Array.isArray(row.changed) ? row.changed.length : 0,
      undone_at: text(row.undone_at),
    }
  },

  /** 一键全撤:把自动转成的 passive 全部还原。撤回不解除「每个群只做一次」的闸门。 */
  async undoAgentFloodAdjustment(adjustmentId: string): Promise<number> {
    const result = await (await currentGroupAdmin()).undoFlood(adjustmentId)
    return result.restored as number
  },
}
