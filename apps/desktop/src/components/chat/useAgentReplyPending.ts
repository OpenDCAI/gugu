import { useEffect, useMemo, useState } from 'react'
import { useAgentDisplayStatus } from '@/hooks/useAgentDisplayStatus'
import {
  agentReplyPending,
  agentReplyPendingDeadline,
  awaitingReplyMessage,
  WAKE_PICKUP_MS,
  type AgentReplyPending,
} from '@/lib/agentReplyPending'
import { refreshCloudComputer, wakeCloudComputer } from '@/lib/cloudComputerStore'
import { useChatStore } from '@/store/chatContext'
import { useAgentCloudState } from './useAgentsOnCloudComputer'

/** 在等它被叫醒的那一段里多久问一次管家:库里那一行、平时 30 秒一次的轮询都跟不上「刚叫醒」。 */
const WAKE_ASK_MS = 4_000
/** 同一时刻有几处在看同一个 agent(输入框上方那一句、聊天里那个气泡):管家只问一次。 */
let lastAsk = 0

function askCloudComputer(): void {
  if (Date.now() - lastAsk < WAKE_ASK_MS - 500) return
  lastAsk = Date.now()
  void refreshCloudComputer().catch(() => undefined)
}

/** 到点重算一次(只为「等太久就不再说它在处理」);没有要等的时刻 = 不动。 */
function useClock(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadline === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [deadline])
  return now
}

/**
 * #7199 和这位 agent 的私聊(chatId 是此刻那条线时才算):它此刻是不是在处理我的话(lib/agentReplyPending)。
 */
export function useAgentReplyPending(chatId: string | null, agentUserId: string | null): { pending: AgentReplyPending; awaitingMessageId: string | null } {
  const { status } = useAgentDisplayStatus(agentUserId)
  const cloud = useAgentCloudState(agentUserId)
  const { activeChatId, messages } = useChatStore('activeChatId', 'messages')
  const awaiting = useMemo(() => (chatId && activeChatId === chatId ? awaitingReplyMessage(messages) : null), [chatId, activeChatId, messages])
  const awaitingSince = awaiting ? Date.parse(awaiting.created_at) : null
  const now = useClock(agentReplyPendingDeadline(cloud, awaitingSince))
  // 刚发出时它住的宿主收回着:管家几秒内会叫醒它,这一段勤着问,好让打字气泡接上「在跑」(❌ 等 30 秒一次的轮询)。
  // 同时由这里叫一次(与管家见待领命令那一叫合并):被拒(积分用完 / 会员到期)当场知道,界面照实说不在线 + 原因
  // (cloudComputerStore.wakeRefused),❌ 打字气泡说着「在处理」、消息却没人收。
  const asleep = cloud?.presence === 'asleep'
  useEffect(() => {
    if (!asleep || awaitingSince === null) return
    const left = awaitingSince + WAKE_PICKUP_MS - Date.now()
    if (left <= 0) return
    void wakeCloudComputer().catch(() => undefined)
    askCloudComputer()
    const timer = window.setInterval(askCloudComputer, WAKE_ASK_MS)
    const stop = window.setTimeout(() => window.clearInterval(timer), left)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(stop)
    }
  }, [asleep, awaitingSince])
  return { pending: agentReplyPending({ status, cloud, awaitingSince, now }), awaitingMessageId: awaiting?.id ?? null }
}
