// @@@6470 话题分栏这条「线」的数据容器:消息窗口 + 对端已读水位。
//
// 实时**不在这里写**:这里只交一个 ChatLine 端口给 subscribeChatLineRevisions,与主区 activeChat(store)
// 走同一份线级订阅 —— 新消息、删除、表情、agent 送达/已读回执、成员已读水位、成员进出,一类不少。
// 此前分栏自己听了两类(message_created 整页替换 + 一份手抄的 member_read_changed),漏了 delivery_changed,
// 于是在话题里 @ agent,它读了你看不到,要刷新或重进才有。
//
// 这里只管「这条线的数据放在哪」,与 store 的差别也只在这一层:话题没有 L2 持久化窗口、没有 thread 视图、
// 不做 MESSAGE_WINDOW 裁剪(分栏往上翻多少就留多少)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById, upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '@/lib/chat'
import { applyMessageWindowRevalidation } from '@/lib/chatMessageRevalidation'
import { subscribeChatLineRevisions } from '@/lib/accountRevisionListeners'
import type { AccountRevisionEvent, AccountRevisionListener } from '@/lib/accountRevisionCoordinator'
import { rendererLogger } from '@/lib/log'
import { reconcileMemberReadSeqs } from '@/store/chatRealtimeMutations'
import { NEWER_PAGE, OLDER_PAGE, maxMainlineSeq } from '@/store/chatMessageWindow'
import { useMemberReadSeqs } from './useMemberReadSeqs'

const topicLineLog = rendererLogger('chat/topic-line')

const NO_MESSAGES: MessageItem[] = []
/** 还没读到(或表还属于上一条话题)时是空表 —— 空表 ⇒ computeReadReceipt 返回 undefined ⇒ 不画环。 */
const NO_READ_SEQS: Record<string, number> = {}

export type TopicLine = {
  messages: MessageItem[]
  loading: boolean
  /** 这条话题自己的对端水位。❌ 不能拿来源线(activeChat)那一格画 —— 那是另一条线的读数。 */
  memberReadSeqs: Record<string, number>
  /** 已经翻到头了没有 —— 到头就不再拉。 */
  reachedOldest: boolean
  revealOlder: () => Promise<void>
  /** 本端刚写成功的一条(发送/附件)先落窗口,回声到了按 id 合并。 */
  appendOwn: (message: MessageItem) => void
  /** 本端改完消息(表情/删除)后重验证这一窗,不等那条修订绕一圈回来。 */
  revalidate: () => Promise<void>
  applyLocalWrite: (rows: MessageItem[], removedIds?: ReadonlySet<string>) => void
  error: unknown
  reload: () => Promise<void>
}

export function useTopicLine(
  chatId: string | null,
  userId: string | null,
  subscribeAccountRevision: (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void,
): TopicLine {
  // 窗口的真值在 ref 里、每次写同步落(与 useMemberReadSeqs 同一个理由):补洞要在事件时刻读「已验证尾」,
  // 函数式 setState 不保证同步执行。窗口认主体(forChatId),换话题时 ❌ 不许把上一条的消息挂在新话题下。
  const windowRef = useRef<{ forChatId: string | null; messages: MessageItem[] }>({ forChatId: null, messages: NO_MESSAGES })
  const [lineWindow, setRenderedWindow] = useState(windowRef.current)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // #7199 这条线最近发出的那一次读(首读与「重试」共用一个号):只有最新那次的结局能写读失败 ——
  // 较早发出、较晚失败的那次 ❌ 盖掉较新那次的成功(读失败由消息列表说「读不到 + 重试」)。
  const readGenRef = useRef(0)
  const [reachedOldest, setReachedOldest] = useState(false)
  const { memberReadSeqs, memberReadSeqsChatRef, setMemberReadSeqs, readMemberReadSeqs } = useMemberReadSeqs()
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  // 换一次话题 +1。在途的旧读取(A → B → A 时第一次 A 的那一发)拿着旧号回来,一律不落。
  const epochRef = useRef(0)
  const revealingOlderRef = useRef(false)
  const reachedOldestRef = useRef(false)
  reachedOldestRef.current = reachedOldest

  const messagesOf = useCallback((target: string): MessageItem[] => (
    windowRef.current.forChatId === target ? windowRef.current.messages : NO_MESSAGES
  ), [])
  const writeMessages = useCallback((target: string, updater: (prev: MessageItem[]) => MessageItem[]) => {
    if (chatIdRef.current !== target) return
    const prev = messagesOf(target)
    const next = updater(prev)
    if (windowRef.current.forChatId === target && next === prev) return
    windowRef.current = { forChatId: target, messages: next }
    setRenderedWindow(windowRef.current)
  }, [messagesOf])

  const loadReadSeqs = useCallback(async (target: string, forUserId: string) => {
    const readSeqs = await chatService.getOtherMembersReadSeqs(target, forUserId)
    if (chatIdRef.current === target) reconcileMemberReadSeqs(target, readSeqs, { memberReadSeqsChatRef, setMemberReadSeqs })
  }, [memberReadSeqsChatRef, setMemberReadSeqs])

  const revalidate = useCallback(async (target: string, throwOnError: boolean) => {
    if (!userId) return
    const ids = messagesOf(target).filter((message) => message.seq >= 0).map((message) => message.id)
    if (ids.length === 0) return
    try {
      const revalidation = await chatService.revalidateWindow(ids, userId)
      const queried = new Set(ids)
      writeMessages(target, (prev) => applyMessageWindowRevalidation(prev, queried, revalidation))
    } catch (error) {
      topicLineLog.error({ error, chatId: target }, 'topic line revalidate failed')
      if (throwOnError) throw error
    }
  }, [messagesOf, userId, writeMessages])

  const applyMessagesSnapshot = useCallback((target: string, msgs: MessageItem[], readSeqs: Record<string, number> | null, epoch: number) => {
    if (epoch !== epochRef.current) return
    if (msgs.length > 0) writeMessages(target, (prev) => mergeMessagesById(prev, msgs, target))
    if (readSeqs && chatIdRef.current === target) reconcileMemberReadSeqs(target, readSeqs, { memberReadSeqsChatRef, setMemberReadSeqs })
  }, [memberReadSeqsChatRef, setMemberReadSeqs, writeMessages])

  // 补洞:问服务端「已验证尾之后还有什么」,结果即真值(与主线 healMessageGap 同口径)。窗口还没有已验证尾、
  // 或回来整页(断档可能超一页)⇒ 改拉最新一页重立窗口 —— 往上翻出来的旧页随之作废,要看再翻。
  const fetchSinceTail = useCallback(async (target: string, forUserId: string) => {
    const tail = maxMainlineSeq(messagesOf(target))
    const newer = tail > 0 ? await chatService.getMessages(target, forUserId, 'loadNewer', NEWER_PAGE, undefined, tail) : null
    if (newer && newer.length < NEWER_PAGE) return { rows: newer, reestablish: false }
    return { rows: await chatService.getMessages(target, forUserId, 'initialLoad', OLDER_PAGE), reestablish: tail > 0 }
  }, [messagesOf])

  const healMessageGap = useCallback(async (target: string, throwOnError: boolean) => {
    if (!userId) return
    const epoch = epochRef.current
    try {
      const [{ rows, reestablish }, readSeqs] = await Promise.all([
        fetchSinceTail(target, userId),
        chatService.getOtherMembersReadSeqs(target, userId),
      ])
      if (epoch !== epochRef.current) return
      if (reestablish) {
        writeMessages(target, () => rows)
        setReachedOldest(false)
      }
      applyMessagesSnapshot(target, reestablish ? [] : rows, readSeqs, epoch)
      // #7199 补洞成了(重连、重试都走这里):读失败不再成立,清掉;比它早发出、还在路上的读也失去资格。
      if (chatIdRef.current === target) {
        readGenRef.current += 1
        setError(null)
      }
    } catch (error) {
      topicLineLog.error({ error, chatId: target }, 'topic line gap heal failed')
      if (throwOnError) throw error
      return
    }
    await revalidate(target, throwOnError)
  }, [applyMessagesSnapshot, fetchSinceTail, revalidate, userId, writeMessages])

  // 换一条话题 = 换一条时间线:翻页记号归零,消息与水位各自拉(一个拉不到不拖累另一个)。
  useEffect(() => {
    epochRef.current += 1
    setReachedOldest(false)
    if (!chatId || !userId) { setLoading(false); return }
    const epoch = epochRef.current
    let cancelled = false
    setLoading(true)
    setError(null)
    const readGen = ++readGenRef.current
    // 新的一条线从空窗口起(收起再打开同一条也一样,❌ 留着上次的行 —— 那期间被删掉的会一直挂着)。
    windowRef.current = { forChatId: chatId, messages: NO_MESSAGES }
    setRenderedWindow(windowRef.current)
    // 首页**合并**进窗口,❌ 整窗替换:首页在途时线级实时已经把刚到的消息落进来了(打开话题、agent 当场回一句),
    // 替换会把它冲掉,要等下一条消息触发补洞才回来。
    void chatService.getMessages(chatId, userId, 'initialLoad', OLDER_PAGE)
      .then((rows) => { if (epoch === epochRef.current) writeMessages(chatId, (prev) => mergeMessagesById(prev, rows, chatId)) })
      .catch((error: unknown) => { if (!cancelled && readGen === readGenRef.current) setError(error); topicLineLog.error({ error, chatId }, 'topic line load failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    // 读不到水位就维持空表 = 不画环。❌ 不画一个算不准的环:空环在产品里的意思是「已发出、无人读」。
    void loadReadSeqs(chatId, userId)
      .catch((error: unknown) => topicLineLog.error({ error, chatId }, 'topic line read seqs load failed'))
    return () => { cancelled = true }
  }, [chatId, userId, loadReadSeqs, writeMessages])

  // 线级实时:与主线同一份订阅。分栏开着才挂(关着时这条线上没有 chat,挂着也只是空转);
  // 换话题不重挂 —— 端口在事件时刻读 chatIdRef。
  const open = chatId !== null
  useEffect(() => {
    if (!open || !userId) return
    return subscribeChatLineRevisions(subscribeAccountRevision, {
      userId,
      chatId: () => chatIdRef.current,
      maxSeqOf: (target) => maxMainlineSeq(messagesOf(target)),
      getMessageSnapshotEpoch: () => epochRef.current,
      applyMessagesSnapshot,
      healMessageGap,
      revalidateWindowOverlays: revalidate,
      setMessagesAndCache: (updater, target) => writeMessages(target, updater),
      // 话题这条线没有 L2 持久化窗口、也没有 thread 视图 —— 这两个 sink 在这条线上无物可写。
      persistWindowToLocalSync: () => undefined,
      setThreadMessages: () => undefined,
      memberReadSeqsChatRef,
      setMemberReadSeqs,
      readMemberReadSeqs,
    })
  }, [open, userId, subscribeAccountRevision, applyMessagesSnapshot, healMessageGap, memberReadSeqsChatRef, messagesOf, readMemberReadSeqs, revalidate, setMemberReadSeqs, writeMessages])

  // 往上翻一页。话题也是一条真的 chat,聊长了就有「之前说过什么」要翻 —— 只拿最新一页的话,滚到顶就是一堵墙。
  const revealOlder = useCallback(async () => {
    const target = chatIdRef.current
    if (!target || !userId || revealingOlderRef.current || reachedOldestRef.current) return
    const oldest = messagesOf(target)[0]
    if (!oldest) return
    revealingOlderRef.current = true
    try {
      const older = await chatService.getMessages(target, userId, 'loadOlder', OLDER_PAGE, oldest.seq)
      if (chatIdRef.current !== target) return
      if (older.length < OLDER_PAGE) setReachedOldest(true)
      const known = new Set(messagesOf(target).map((message) => message.id))
      const fresh = older.filter((message) => !known.has(message.id))
      if (fresh.length === 0) return
      writeMessages(target, (prev) => [...fresh, ...prev])
    } catch (error) {
      // ❌ 不静默:翻不出来与「真的到头了」是两件事,后者才能置 reachedOldest。
      topicLineLog.error({ error, chatId: target }, 'topic line reveal older failed')
    } finally {
      revealingOlderRef.current = false
    }
  }, [messagesOf, userId, writeMessages])

  const appendOwn = useCallback((message: MessageItem) => {
    writeMessages(message.chat_id, (prev) => upsertMessageById(prev, message))
  }, [writeMessages])

  const revalidateOpen = useCallback(async () => {
    const target = chatIdRef.current
    if (target) await revalidate(target, false)
  }, [revalidate])

  const applyLocalWrite = useCallback((rows: MessageItem[], removedIds?: ReadonlySet<string>) => {
    const target = chatIdRef.current
    if (target) writeMessages(target, (previous) => mergeMessagesById(previous.filter((row) => !removedIds?.has(row.id)), rows, target))
  }, [writeMessages])
  const reload = useCallback(async () => {
    const target = chatIdRef.current
    if (!target) return
    const readGen = ++readGenRef.current
    const latest = () => readGen === readGenRef.current && chatIdRef.current === target
    try { await healMessageGap(target, true); if (latest()) setError(null) } catch (error) { if (latest()) setError(error) }
  }, [healMessageGap])

  return {
    messages: chatId && lineWindow.forChatId === chatId ? lineWindow.messages : NO_MESSAGES,
    loading,
    // 表属于哪条 chat 由 reconcile 同步写在 ref 上、先于那次 setState ⇒ 渲染期读它就是这张表的主体。
    memberReadSeqs: chatId && memberReadSeqsChatRef.current === chatId ? memberReadSeqs : NO_READ_SEQS,
    reachedOldest,
    revealOlder,
    appendOwn,
    revalidate: revalidateOpen,
    applyLocalWrite, error, reload,
  }
}
