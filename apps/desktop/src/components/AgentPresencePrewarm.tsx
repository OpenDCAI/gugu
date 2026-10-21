import { useEffect, useMemo } from 'react'
import { useChatStore } from '../store/chatContext'
import { prewarmAgentPresence } from '../lib/agentPresenceStore'
import { collectChatAgentUserIds } from '../lib/agentPresencePrewarm'

// @@@3839 D — 只做一件事：会话列表一解析出它的 agent 成员，就让 presence store 去认识它们。
// 于是不管用户先点进消息、通讯录还是某个群，那些 agent 都已经被观测过，「确认中」只留给真没见过的。
//
// 为什么是挂在 provider 外的一个组件，而不是写进 store/chat.tsx：预热是**消费**会话列表的结论，
// 不是会话列表的职责，它通过公开 context 读就够了；而那个文件是受行数棘轮冻结的 god file，
// 往里塞一段与它自身契约无关的代码，正是它当初长成 god file 的方式。
export function AgentPresencePrewarm() {
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  // 按 id 集合的**值**建 key：会话列表每次刷新都会给出新数组，按引用会每次都重新预热一遍。
  const agentIdsKey = useMemo(
    () => collectChatAgentUserIds(chats, identitiesById).join(','),
    [chats, identitiesById],
  )
  useEffect(() => {
    if (!agentIdsKey) return
    prewarmAgentPresence(agentIdsKey.split(','))
  }, [agentIdsKey])
  return null
}
