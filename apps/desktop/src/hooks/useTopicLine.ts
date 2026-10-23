// Topic and task surfaces subscribe to the account-owned message window.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById, upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '@/lib/chat'
import { subscribeChatLineRevisions } from '@/lib/accountRevisionListeners'
import type { AccountRevisionEvent, AccountRevisionListener } from '@/lib/accountRevisionCoordinator'
import { rendererLogger } from '@/lib/log'
import { reconcileMemberReadSeqs } from '@/store/chatRealtimeMutations'
import { OLDER_PAGE, maxMainlineSeq } from '@/store/chatMessageWindow'
import { useMemberReadSeqs } from './useMemberReadSeqs'
import { useChatStore } from '@/store/chatContext'

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
  const { messageWindows, subscribeChatWindow } = useChatStore('messageWindows', 'subscribeChatWindow')
  const subscribe = useCallback((listener: () => void) => chatId ? subscribeChatWindow(chatId, listener) : () => undefined, [chatId, subscribeChatWindow])
  const snapshot = useCallback(() => chatId ? messageWindows.read(chatId) ?? NO_MESSAGES : NO_MESSAGES, [chatId, messageWindows])
  const messages = useSyncExternalStore(subscribe, snapshot)
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

  const messagesOf = useCallback((target: string): MessageItem[] => messageWindows.read(target) ?? NO_MESSAGES, [messageWindows])
  const writeMessages = useCallback((target: string, updater: (prev: MessageItem[]) => MessageItem[]) => {
    if (chatIdRef.current === target) messageWindows.write(target, updater)
  }, [messageWindows])
  const acceptReadSeqs = useCallback((target: string, readSeqs: Record<string, number>) => {
    if (chatIdRef.current === target) reconcileMemberReadSeqs(target, readSeqs, { memberReadSeqsChatRef, setMemberReadSeqs })
  }, [memberReadSeqsChatRef, setMemberReadSeqs])
  const revalidate = messageWindows.revalidate
  const applyMessagesSnapshot = useCallback((target: string, msgs: MessageItem[], readSeqs: Record<string, number> | null, epoch: number) => {
    if (epoch !== epochRef.current) return
    if (msgs.length > 0) writeMessages(target, (prev) => mergeMessagesById(prev, msgs, target))
    if (readSeqs && chatIdRef.current === target) reconcileMemberReadSeqs(target, readSeqs, { memberReadSeqsChatRef, setMemberReadSeqs })
  }, [memberReadSeqsChatRef, setMemberReadSeqs, writeMessages])

  const healMessageGap = useCallback(async (target: string, throwOnError: boolean) => {
    const epoch = epochRef.current
    try {
      await messageWindows.heal(target, true, (seqs) => { if (epoch === epochRef.current) acceptReadSeqs(target, seqs) })
      if (epoch === epochRef.current) { readGenRef.current += 1; setError(null) }
    } catch (error) { if (throwOnError) throw error; topicLineLog.error({ error, chatId: target }, 'topic line gap heal failed') }
  }, [acceptReadSeqs, messageWindows])

  useEffect(() => {
    const epoch = ++epochRef.current
    setReachedOldest(false)
    setError(null)
    if (!chatId || !userId) { setLoading(false); return }
    let cancelled = false
    const readGen = ++readGenRef.current
    const current = () => !cancelled && epoch === epochRef.current
    setLoading(!messagesOf(chatId).length)
    void messageWindows.open(chatId, {
      current,
      painted: (_rows, hasOlder) => { setLoading(false); if (hasOlder !== undefined) setReachedOldest(!hasOlder && messagesOf(chatId).some((row) => row.seq === 1)) },
      ready: (hasOlder) => { setLoading(false); if (hasOlder !== undefined) setReachedOldest(!hasOlder && messagesOf(chatId).some((row) => row.seq === 1)) },
      readSeqs: (seqs) => acceptReadSeqs(chatId, seqs),
    }).catch((error: unknown) => {
      if (current() && readGen === readGenRef.current) setError(error)
      topicLineLog.error({ error, chatId }, 'topic line load failed')
    }).finally(() => { if (current()) setLoading(false) })
    return () => { cancelled = true }
  }, [chatId, userId, acceptReadSeqs, messageWindows, messagesOf])

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
      persistWindowToLocalSync: messageWindows.persist,
      setThreadMessages: () => undefined,
      memberReadSeqsChatRef,
      setMemberReadSeqs,
      readMemberReadSeqs,
    })
  }, [open, userId, subscribeAccountRevision, applyMessagesSnapshot, healMessageGap, memberReadSeqsChatRef, messagesOf, readMemberReadSeqs, revalidate, setMemberReadSeqs, writeMessages, messageWindows])

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
      await revalidate(target, false)
    } catch (error) {
      // ❌ 不静默:翻不出来与「真的到头了」是两件事,后者才能置 reachedOldest。
      topicLineLog.error({ error, chatId: target }, 'topic line reveal older failed')
    } finally {
      revealingOlderRef.current = false
    }
  }, [messagesOf, userId, writeMessages, revalidate])

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
    messages,
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
