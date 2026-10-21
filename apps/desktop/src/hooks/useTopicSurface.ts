// 聊天区的「话题」这一面 —— product spec。
//
// 为什么单独一个 hook:ChatAreaPanel 是冻结的 god 文件(CI 有行数闸),而话题要在它身上加四样东西
// (锚点卡数据、分栏、开话题动作、成员列表开关)。把状态收在这里,面板那边只剩渲染。
//
// 分栏里的那条话题**是一条真的 chat**,所以它有自己的一条「线」(useTopicLine:消息窗口 + 已读水位),
// 与老 thread 面板的根本差别就在这:老面板是同一个 chat 里的一段过滤视图,新分栏是另一条线。
// 线的实时与主区 activeChat 走同一份 subscribeChatLineRevisions(#6470),❌ 在这里另听线级事件。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatItem, MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { chatService } from '@/lib/chat'
import type { AccountRevisionEvent, AccountRevisionListener } from '@/lib/accountRevisionCoordinator'
import { topicService } from '@/lib/topics'
import { writeIdempotentChatMessage } from '@/lib/chatMessageWriter'
import { sendAttachmentBatch } from '@/components/chat/sendAttachmentBatch'
import { topicsSourceChatId, useTopicsOfChat } from './useTopics'
import { useTopicLine } from './useTopicLine'
import { rendererLogger } from '@/lib/log'

const topicSurfaceLog = rendererLogger('chat/topic-surface')

export type OpenTopic = { chatId: string; name: string }

type UseTopicSurfaceArgs = {
  /** 当前打开的那条线。它自己是话题时,不再往下长话题(单层不嵌套,由 topicsSourceChatId 守)。 */
  chat: Pick<ChatItem, 'id' | 'kind'> | null | undefined
  userId: string | null
  /** 打开右侧槽位前先让别的右栏让位(ChatAreaPanel 的 closeRightSurfaces)。 */
  closeRightSurfaces: () => void
  /**
   * 开不出话题时叫一声。**必填**:原来这里把错误存进一个没人读的 state,于是右键「开话题」
   * 失败时界面上什么都不发生 —— 静默失败比报错难查得多,所以把「谁来喊」做成调用方必须给的东西。
   */
  onCreateFailed: (error: unknown) => void
  subscribeAccountRevision: (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void
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
  /** 右侧分栏里那条话题(null = 没开分栏)。 */
  splitTopic: OpenTopic | null
  splitMessages: MessageItem[]
  splitLoading: boolean
  /** 分栏那条话题自己的对端已读水位(来源线那一格是另一条线的读数)。 */
  splitMemberReadSeqs: Record<string, number>
  openSplit: (topic: OpenTopic) => void
  closeSplit: () => void
  /** @param toUserIds 正文里 @ 到的人 —— 被 @ 就是被拉进来(服务端触发器只认来源线成员)。 */
  /** @param replyToMessageId 引用的那条消息 —— 结构化回复,与主线同口径(group-routing:回复穿透档位)。 */
  sendInSplit: (text: string, toUserIds?: readonly string[] | null, replyToMessageId?: string | null) => Promise<void>
  /**
   * 分栏里发附件。不接它不等于「分栏不支持附件」—— InputArea 的回形针/拖放/粘贴
   * 三条入队路径都是无条件的,而 handleSend 在没有这个回调时会先清空队列再跳过发送 ⇒
   * 文件凭空消失、一声不响。所以这一口必须接上。
   */
  sendAttachmentsInSplit: (files: File[], opts?: { toUserIds?: string[] | null; caption?: string; onSent?: (file: File, index: number) => void }) => Promise<void>
  /** 在分栏里改过消息(表情/删除)之后重验证这一栏,不等修订绕一圈回来。 */
  refreshSplit: () => Promise<void>
  /**
   * 往上翻一页。话题也是一条真的 chat,聊长了就有「之前说过什么」要翻 ——
   * 只拿最新一页的话,滚到顶就是一堵墙,而且不报错。
   */
  revealOlderInSplit: () => Promise<void>
  /** 已经翻到头了没有 —— 到头就不再拉。 */
  splitReachedOldest: boolean
  /** 从一条消息开一条话题:建完直接分栏打开,这就是 spec 的「建立是一步」。 */
  openTopicFromMessage: (sourceMessageId: string) => Promise<void>
}

export function useTopicSurface({
  chat,
  userId,
  closeRightSurfaces,
  subscribeAccountRevision,
  onCreateFailed,
}: UseTopicSurfaceArgs): TopicSurface {
  const chatId = chat?.id ?? null
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
  // @@@3922 分栏也是「关于某条线」的读数:它贴着来源线开,来源线一换它就不该再显示。
  // 状态与它所属的来源线存在一起(subject-scoped),渲染期收口 —— 靠副作用清空永远慢一帧,
  // 那一帧里 A 线的分栏会挂在 B 线的旁边。
  const [splitState, setSplitState] = useState<{ forChatId: string | null; topic: OpenTopic | null }>(
    { forChatId: null, topic: null },
  )
  const splitTopic = splitState.forChatId === chatId ? splitState.topic : null
  const chatIdRef = useRef<string | null>(null)
  chatIdRef.current = chatId
  const splitChatId = splitTopic?.chatId ?? null
  const splitChatIdRef = useRef<string | null>(null)
  splitChatIdRef.current = splitChatId
  const line = useTopicLine(splitChatId, userId, subscribeAccountRevision)
  const { messages: splitMessages, appendOwn } = line

  // 已读水位:分栏里读到的东西不推水位,那条话题在会话列表里就永远挂着未读 ——
  // 「通知只到参与者」的另一半是「读过了就不再叫你」。ref 记住推到哪儿了,❌ 每次渲染都往服务端发一次。
  const markedSeqRef = useRef<{ chatId: string | null; seq: number }>({ chatId: null, seq: 0 })
  useEffect(() => {
    if (!splitChatId || splitMessages.length === 0) return
    // 「看得见」不等于「参与」:非参与者在这条话题上根本没有 chat_members 行,推水位必然失败,
    // 每开一次分栏就刷一条错误日志 —— 而那既不是故障也无事可做(他本来就没有未读要清)。
    if (!topics.find((topic) => topic.chat_id === splitChatId)?.is_participant) return
    const top = splitMessages.reduce((max, message) => (message.seq > max ? message.seq : max), 0)
    if (top <= 0) return
    const marked = markedSeqRef.current
    if (marked.chatId === splitChatId && marked.seq >= top) return
    markedSeqRef.current = { chatId: splitChatId, seq: top }
    void chatService.markRead(splitChatId, top).catch((error) => {
      // 推失败就把水位退回去,下一批消息到达时再试 —— ❌ 不静默吞掉,否则未读永远清不掉且没人知道。
      markedSeqRef.current = { chatId: splitChatId, seq: marked.chatId === splitChatId ? marked.seq : 0 }
      topicSurfaceLog.error({ error, chatId: splitChatId, seq: top }, 'topic split markRead failed')
    })
  }, [splitChatId, splitMessages, topics])

  const openSplit = useCallback(
    (topic: OpenTopic) => {
      // 再点一次**正开着的同一条**:只更新名字,❌ 不走 closeRightSurfaces(#6404:那一路曾把分栏的消息清空、
      // 而同一批里又设回同一条 ⇒ 拉取不重跑 ⇒ 分栏开着但一条消息都没有)。
      if (splitChatIdRef.current === topic.chatId) {
        setSplitState({ forChatId: chatIdRef.current, topic })
        return
      }
      closeRightSurfaces()
      setSplitState({ forChatId: chatIdRef.current, topic })
    },
    [closeRightSurfaces],
  )

  const closeSplit = useCallback(() => {
    setSplitState({ forChatId: null, topic: null })
  }, [])

  const sendAttachmentsInSplit = useCallback(
    async (files: File[], opts?: { toUserIds?: string[] | null; caption?: string; onSent?: (file: File, index: number) => void }) => {
      if (!files.length) return
      // fail-loud:缺会话/登录态时静默 return 会让 composer 走成功路清空从未发出的附件(同 #2188)。
      if (!splitChatId || !userId) throw new Error('topic split attachment: no open topic or no signed-in user')
      await sendAttachmentBatch({
        files,
        chatId: splitChatId,
        senderId: userId,
        toUserIds: opts?.toUserIds?.length ? opts.toUserIds : null,
        caption: opts?.caption,
        onSent: opts?.onSent,
        // 分栏的消息在这条话题自己的线里(不进 store 的 activeChat 窗),所以追加到这一份里去。
        appendMessage: appendOwn,
      })
    },
    [splitChatId, userId, appendOwn],
  )

  const sendInSplit = useCallback(
    async (text: string, toUserIds?: readonly string[] | null, replyToMessageId?: string | null) => {
      const body = text.trim()
      if (!body || !splitChatId || !userId) return
      const sent = await writeIdempotentChatMessage({
        id: crypto.randomUUID(),
        chatId: splitChatId,
        senderUserId: userId,
        // 「参与:靠在里面说话,或被 @ 进来」——@ 到谁就把谁投给谁,拉不拉得进来由服务端的
        // join_topic_participants 判(它只放行来源线的成员)。这里❌ 不做第二道判断。
        toUserIds: toUserIds && toUserIds.length > 0 ? [...toUserIds] : null,
        content: body,
        contentType: 'text',
        replyToMessageId: replyToMessageId ?? null,
        threadRootId: null,
        isThreadRoot: false,
        isWhisper: false,
      })
      appendOwn(sent)
    },
    [splitChatId, userId, appendOwn],
  )

  const openTopicFromMessage = useCallback(
    async (sourceMessageId: string) => {
      if (!chatId) return
      try {
        // 名字交给服务端从来源消息截 —— 一处口径,客户端不再截第二遍。
        const created = await topicService.createTopic({
          sourceChatId: chatId,
          sourceMessageId,
        })
        reloadTopics()
        openSplit({ chatId: created.chat_id, name: created.name })
      } catch (error) {
        // fail loud:开不出来必须当场告诉用户。原因进日志(用户拿内部失败描述做不了任何事),
        // 文案只留他能照做的下一步。
        topicSurfaceLog.error({ error, chatId, sourceMessageId }, 'open topic failed')
        onCreateFailedRef.current(error)
      }
    },
    [chatId, openSplit, reloadTopics],
  )

  return {
    anchorsByMessageId: bySourceMessageId,
    topics,
    reloadTopics,
    splitTopic,
    splitMessages,
    splitLoading: line.loading,
    splitMemberReadSeqs: line.memberReadSeqs,
    openSplit,
    closeSplit,
    sendInSplit,
    sendAttachmentsInSplit,
    refreshSplit: line.revalidate,
    revealOlderInSplit: line.revealOlder,
    splitReachedOldest: line.reachedOldest,
    openTopicFromMessage,
  }
}
