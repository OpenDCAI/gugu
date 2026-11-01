// 聊天区的「话题」这一面 —— product spec。
//
// 为什么单独一个 hook:ChatAreaPanel 是冻结的 god 文件(CI 有行数闸),而话题要在它身上加四样东西
// (锚点卡数据、分栏、开话题动作、成员列表开关)。把状态收在这里,面板那边只剩渲染。
//
// 分栏里的那条话题**是一条真的 chat**,所以它有自己的一条「线」(useChatConversation:消息窗口 + 已读水位),
// 与老 thread 面板的根本差别就在这:老面板是同一个 chat 里的一段过滤视图,新分栏是另一条线。
// 线的实时与主区 activeChat 走同一份 subscribeChatLineRevisions(#6470),❌ 在这里另听线级事件。
import { useCallback, useEffect, useRef } from 'react'
import type { ChatItem, MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import type { AccountRevisionEvent, AccountRevisionListener } from '@/lib/accountRevisionCoordinator'
import { topicService } from '@/lib/topics'
import { useChatStore } from '@/store/chatContext'
import { topicsSourceChatId, useTopicsOfChat } from './useTopics'
import { useChatConversation, type ChatConversation } from '@/store/useChatConversation'
import { rendererLogger } from '@/lib/log'
import { topicNameFromMessage } from '@/components/chat/topicAnchorModels'
import { useTabsReading } from '@/components/appSlot/useTabsReading'
import { closeTopicTab, focusedChatTab, hideTopicTab, openTopicTab, topicTabOf } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'

const topicSurfaceLog = rendererLogger('chat/topic-surface')

export type OpenTopic = { chatId: string; name: string }

type UseTopicSurfaceArgs = {
  /** 当前打开的那条线。它自己是话题时,不再往下长话题(单层不嵌套,由 topicsSourceChatId 守)。 */
  chat: Pick<ChatItem, 'id' | 'kind'> | null | undefined
  userId: string | null
  messages: readonly Pick<MessageItem, 'id' | 'content' | 'content_type'>[]
  /** 打开右侧槽位前先让别的右栏让位(ChatAreaPanel 的 closeRightSurfaces)。 */
  closeRightSurfaces: () => void
  /**
   * 开不出话题时叫一声。**必填**:原来这里把错误存进一个没人读的 state,于是右键「开话题」
   * 失败时界面上什么都不发生 —— 静默失败比报错难查得多,所以把「谁来喊」做成调用方必须给的东西。
   */
  onCreateFailed: (error: unknown) => void
  subscribeAccountRevision: (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void
  /**
   * The chat is drawn in a block, whose strip has the topic as a tab beside the group's (on screen when either half of
   * the pair is it); else (the phone) the topic is up only while it is the page in front.
   */
  embedded: boolean
}

/** 事件载荷里的 chat_id —— 形状坏了就当没这条,❌ 不因为一条脏事件把整个订阅拆了。 */
function revisionChatIds(operations: readonly { payload: unknown }[]): string[] {
  const ids: string[] = []
  for (const operation of operations) {
    const payload = operation.payload
    if (!payload || typeof payload !== 'object') continue
    const chatId = (payload as { chat_id?: unknown }).chat_id
    if (typeof chatId === 'string' && chatId) ids.push(chatId)
  }
  return ids
}

export type TopicSurface = {
  /** 这条线上长出来的话题,按来源消息分组 —— 锚点卡读它。 */
  anchorsByMessageId: Map<string, TopicSummary[]>
  topics: TopicSummary[]
  reloadTopics: () => void
  /** The open tab's conversation, retained while another tab is shown. */
  topic: OpenTopic | null
  /** 右侧分栏里那条话题(null = 没开分栏)。 */
  splitTopic: OpenTopic | null
  splitLine: ChatConversation
  openSplit: (topic: OpenTopic, toggle?: boolean) => void
  closeSplit: () => void
  /** @param toUserIds 正文里 @ 到的人 —— 被 @ 就是被拉进来(服务端触发器只认来源线成员)。 */
  /** @param replyToMessageId 引用的那条消息 —— 结构化回复,与主线同口径(group-routing:回复穿透档位)。 */
  sendInSplit: (text: string, toUserIds?: readonly string[] | null, replyToMessageId?: string | null, isWhisper?: boolean, submittedAt?: number) => Promise<void>
  /**
   * 分栏里发附件。不接它不等于「分栏不支持附件」—— InputArea 的回形针/拖放/粘贴
   * 三条入队路径都是无条件的,而 handleSend 在没有这个回调时会先清空队列再跳过发送 ⇒
   * 文件凭空消失、一声不响。所以这一口必须接上。
   */
  sendAttachmentsInSplit: (files: File[], opts?: { toUserIds?: string[] | null; isWhisper?: boolean; caption?: string; onSent?: (file: File, index: number) => void }) => Promise<void>
  /** 从一条消息开一条话题:建完直接分栏打开,这就是 spec 的「建立是一步」。 */
  openTopicFromMessage: (sourceMessageId: string) => Promise<void>
}

export function useTopicSurface({
  chat,
  userId,
  messages,
  closeRightSurfaces,
  subscribeAccountRevision,
  onCreateFailed,
  embedded,
}: UseTopicSurfaceArgs): TopicSurface {
  const { conversations, createTopic } = useChatStore('conversations', 'createTopic')
  const chatId = chat?.id ?? null
  const sourceMessages = useRef(messages)
  sourceMessages.current = messages
  // 调用方传的是内联箭头;直接进依赖会让 openTopicFromMessage 每次渲染换身份 ——
  // 它原样下传给每条消息气泡,于是任何一次面板重渲都打穿全部气泡的 memo。只在事件时刻取最新的那个。
  const onCreateFailedRef = useRef(onCreateFailed)
  onCreateFailedRef.current = onCreateFailed
  // 清单只有一个属主:useTopicsOfChat。锚点卡与顶栏话题面板读的是同一份,❌ 不各拉各的。
  const subscribeChatChanged = useCallback(
    (listener: (chatIds: readonly string[]) => void) =>
      subscribeAccountRevision('chat_changed', (operations) => listener(revisionChatIds(operations))),
    [subscribeAccountRevision],
  )
  const { topics, bySourceMessageId, reload: reloadTopics } = useTopicsOfChat(
    topicsSourceChatId(chat),
    subscribeChatChanged,
  )
  // 分栏是这条线页签条上的一枚(chat-tabs/chat-layouts):开着哪条话题、在不在屏上都由那里说,按来源线各记各的
  // (@@@3922 的 subject-scoped 由此而来:换了来源线读的就是另一条页签条)。
  const tab = useTabsReading(() => {
    if (!chatId) return null
    const tab = topicTabOf(chatId)
    if (!tab) return null
    const up = embedded ? tab.shown : focusedChatTab(chatId)?.tabId === tab.tabId
    return { topic: { chatId: tab.topic.topicChatId, name: tab.topic.name }, shown: up }
  }, [chatId, embedded])
  const topic = tab?.topic ?? null
  const splitTopic = tab?.shown ? topic : null
  const chatIdRef = useRef<string | null>(null)
  chatIdRef.current = chatId
  const splitChatId = topic?.chatId ?? null
  const splitChatIdRef = useRef<string | null>(null)
  splitChatIdRef.current = splitTopic?.chatId ?? null
  const line = useChatConversation(splitChatId, conversations)
  const sendSplitMessage = line.sendMessage

  // Covers normal opening and an outbox retry opening the existing tab.
  useEffect(() => { if (splitChatId) reloadTopics() }, [splitChatId, reloadTopics])

  const openSplit = useCallback(
    (topic: OpenTopic, toggle = false) => {
      const source = chatIdRef.current
      if (!source) return
      // Sidebar reactivation puts the split away; other open requests only update its name.
      // ❌ 不走 closeRightSurfaces(#6404:那一路曾把分栏的消息清空、
      // 而同一批里又设回同一条 ⇒ 拉取不重跑 ⇒ 分栏开着但一条消息都没有)。
      if (splitChatIdRef.current === topic.chatId) {
        if (toggle) hideTopicTab(source)
        else openTopicTab(source, { topicChatId: topic.chatId, name: topic.name })
        return
      }
      closeRightSurfaces()
      openTopicTab(source, { topicChatId: topic.chatId, name: topic.name })
    },
    [closeRightSurfaces],
  )

  const closeSplit = useCallback(() => {
    if (chatIdRef.current) closeTopicTab(chatIdRef.current)
  }, [])

  const sendInSplit = useCallback(
    async (text: string, toUserIds?: readonly string[] | null, replyToMessageId?: string | null, isWhisper?: boolean, submittedAt?: number) => {
      const body = text.trim()
      if (!body || !splitChatId || !userId) return
      await sendSplitMessage(body, {
        toUserIds: toUserIds?.length ? [...toUserIds] : null,
        replyToMessageId: replyToMessageId ?? null,
        isWhisper, ...(submittedAt === undefined ? {} : { submittedAt }),
      })
    },
    [splitChatId, userId, sendSplitMessage],
  )

  const openTopicFromMessage = useCallback(
    async (sourceMessageId: string) => {
      if (!chatId) return
      try {
        const source = sourceMessages.current.find((message) => message.id === sourceMessageId)
        if (!source) throw new Error('Topic source message is not in the current message window')
        if (source.content_type === 'card' && parseComposerCard(source.content)?.type === 'task') {
          const existing = (await topicService.listTopicsOfChat(chatId)).find((topic) => topic.source_message_id === sourceMessageId)
          if (existing) { openSplit({ chatId: existing.chat_id, name: existing.name }); return }
        }
        const created = await createTopic({
          sourceChatId: chatId,
          sourceMessageId,
          // 任务卡上开的话题(手机点卡、老卡还没有话题时)叫任务那句话,❌ 落成服务端的默认名。
          name: source.content_type === 'text' ? topicNameFromMessage(source.content)
            : source.content_type === 'card' ? topicNameFromMessage(parseComposerCard(source.content)?.text) : null,
        })
        if (!created) return // retained outbox failure already exposes retry/discard
        openSplit({ chatId: created.chat_id, name: created.name })
      } catch (error) {
        // fail loud:开不出来必须当场告诉用户。原因进日志(用户拿内部失败描述做不了任何事),
        // 文案只留他能照做的下一步。
        topicSurfaceLog.error({ error, chatId, sourceMessageId }, 'open topic failed')
        onCreateFailedRef.current(error)
      }
    },
    [chatId, openSplit, createTopic],
  )

  return {
    anchorsByMessageId: bySourceMessageId,
    topics,
    reloadTopics,
    topic,
    splitTopic,
    splitLine: line,
    openSplit,
    closeSplit,
    sendInSplit,
    sendAttachmentsInSplit: async (files, opts) => { await line.sendAttachments(files, opts) },
    openTopicFromMessage,
  }
}
