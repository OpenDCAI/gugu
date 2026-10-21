// @@@5856 「群里 agent 超过 5 个 → 全员转 passive」那条系统消息的定位。
//
// 为什么要一个 hook 而不是每条系统消息各查一次:每个群**最多一条**台账(spec:只做一次),
// 所以一条线查一次就够。逐条消息去查等于把 O(1) 做成 O(n) 次往返。
import { useCallback, useEffect, useRef, useState } from 'react'
import { topicService, type AgentFloodAdjustment } from '@/lib/topics'
import { chatDb } from '@/lib/supabase'
import { rendererLogger } from '@/lib/log'

const floodNoticeLog = rendererLogger('chat/agent-flood-notice')
/** 台账读失败后重试的间隔。一次抖动不该让「一键全撤」永久消失。 */
const LEDGER_RETRY_MS = 3000

export function useAgentFloodNotice(
  chatId: string | null,
  /**
   * 这条线当前的消息。只用来取「最后一条系统消息的 id」当重查信号 ——
   * 自动调档的触发器是 AFTER INSERT ON chat_members,也就是你**刚加完第 6 个 agent、正看着这个群**
   * 的那一刻落的消息。原先只在切会话时查台账 ⇒ 首次发生时那颗「一键全撤」根本不存在,
   * 切走再切回来才长出来,而 spec 要的是「**就在那条消息上**一键全撤」。
   */
  messages: readonly { id: string; content_type: string }[] = [],
): {
  /** 承载「一键全撤」的那条系统消息 id;没有就是 null。 */
  noticeMessageId: string | null
  reload: () => void
} {
  // @@@3922 与本仓那一族同形:读数是「关于某条线」的,但只能在副作用里追上 chatId。
  // 存的时候连主体一起存,渲染期比对 —— 不符就当没有。否则切会话那一帧,A 群那条系统消息的
  // 撤回按钮会挂到 B 群某条同 id 的消息上(id 不会撞,但「有没有」这件事会错一帧)。
  const [notice, setNotice] = useState<{ forChatId: string | null; messageId: string | null }>(
    { forChatId: null, messageId: null },
  )
  const [reloadToken, setReloadToken] = useState(0)
  // 取最后一条系统消息的 id:它变了就说明这条线上刚落了一条系统消息,台账值得再查一次。
  // ❌ 不按 messages 整体做依赖 —— 那会让每一条普通消息都触发一次往返。
  let latestSystemMessageId: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.content_type === 'system') { latestSystemMessageId = messages[index]!.id; break }
  }
  const seqRef = useRef(0)
  const lookupFailedRef = useRef(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 换线时把「已经重试过一次」清掉 —— 否则 A 线失败过之后,B 线的第一次失败拿不到那次重试。
  const retriedForChatRef = useRef<string | null>(null)
  useEffect(() => {
    const seq = ++seqRef.current
    if (retriedForChatRef.current !== chatId) {
      retriedForChatRef.current = chatId
      lookupFailedRef.current = false
    }
    if (!chatId) {
      setNotice({ forChatId: null, messageId: null })
      return
    }
    setNotice({ forChatId: chatId, messageId: null })
    let cancelled = false
    void (async () => {
      const { data, error } = await chatDb
        .from('agent_flood_adjustments')
        .select('message_id')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(1)
      if (cancelled || seq !== seqRef.current) return
      if (error) {
        // ❌ 读失败 ≠ 这条线上没发生过自动调档。原来两者一起 return,于是那条居中系统消息照常说
        // 「已把它们全部改为点名才回」,底下却连「全部撤回」都没有 —— spec 要的「就在那条消息上
        // 一键全撤」静默消失,而且没有任何人知道。
        //
        // ⚠️ 如实记一笔:**持续失败时的行为和修之前一样**(拿不到 message_id 就挂不上那个组件)。
        // 这里能治的只有抖动 —— 记一条日志 + 过几秒自己再读一次。要让持续失败也显形,得换一种
        // 定位方式(比如按系统消息自己的 client_message_id 认),那是另一条改动。
        floodNoticeLog.error({ error, chatId, willRetry: !lookupFailedRef.current }, 'agent flood ledger lookup failed')
        setNotice({ forChatId: chatId, messageId: null })
        if (!lookupFailedRef.current) {
          lookupFailedRef.current = true
          retryTimerRef.current = setTimeout(() => setReloadToken((token) => token + 1), LEDGER_RETRY_MS)
        }
        return
      }
      lookupFailedRef.current = false
      const row = (data ?? [])[0] as { message_id?: unknown } | undefined
      setNotice({ forChatId: chatId, messageId: typeof row?.message_id === 'string' ? row.message_id : null })
    })()
    return () => {
      cancelled = true
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
    }
  }, [chatId, reloadToken, latestSystemMessageId])

  return {
    noticeMessageId: notice.forChatId === chatId ? notice.messageId : null,
    reload: useCallback(() => setReloadToken((token) => token + 1), []),
  }
}

export type { AgentFloodAdjustment }
export { topicService }
