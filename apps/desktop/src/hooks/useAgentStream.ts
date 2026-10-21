// 订阅 ACP agent 流式输出（#966 gate A），返回指定会话当前的流式状态。
//
// 事件源：electron preload 把主进程的 'agent-stream' IPC 转成 window CustomEvent(UI_EVENTS.agentStream)。
// 累积逻辑在纯 reducer agentStreamState 里（已单测）。本地 agent + 本地查看场景；跨设备/群广播待后续。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AgentStreamPayload } from '@gugu/core/shared/types/agentStream'
import { UI_EVENTS } from '../lib/uiEvents'
import { agentStreamKey, reduceAgentStream, type AgentStreamMap, type AgentStreamState } from '../lib/agentStreamState'

// @@@1687 slice3a —— 在纯 reducer 之外旁挂「最后收到流事件的时刻」(per key)。不进 reducer：reducer
// 保持纯函数 + 已单测不动。渲染端据此判**真流静默**(非墙钟)→ slice3a 显「似乎卡住了」,不重蹈 #1675。
export type AgentStreamLive = AgentStreamState & { lastEventAt: number }

type StreamStore = { map: AgentStreamMap; lastEventAt: Record<string, number>; listeners: Set<() => void> }

// @@@stream-scoped-render — 全部会话的流都累积在这里,但组件只按**自己那个 key** 订阅:
// 从前任何会话的一个流片段都 setState 整张表 → 整个聊天面板(连同每条可见气泡)重渲一遍,
// 后台几个 agent 同时在跑时就是每秒几十次无关重渲。现在别的 key 的片段不唤醒这个组件。
export function useAgentStream(
  conversationId: string | null | undefined,
  threadRootId: string | null | undefined,
): AgentStreamLive | null {
  const [store] = useState<StreamStore>(() => ({ map: {}, lastEventAt: {}, listeners: new Set() }))

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as AgentStreamPayload | undefined
      if (!detail || typeof detail.conversationId !== 'string' || typeof detail.agentUserId !== 'string') return
      const key = agentStreamKey(detail.conversationId, detail.threadRootId ?? null)
      // @@@1687 终态清掉时戳；其余事件(message_chunk/thought_chunk/tool_call)刷新「最后活动」→ 静默检测基准。
      if (detail.event.type === 'done' || detail.event.type === 'error') delete store.lastEventAt[key]
      else store.lastEventAt[key] = Date.now()
      store.map = reduceAgentStream(store.map, detail.conversationId, detail.threadRootId ?? null, detail.agentUserId, detail.event)
      for (const listener of store.listeners) listener()
    }
    window.addEventListener(UI_EVENTS.agentStream, handler)
    return () => window.removeEventListener(UI_EVENTS.agentStream, handler)
  }, [store])

  const key = conversationId ? agentStreamKey(conversationId, threadRootId) : null
  const subscribe = useMemo(() => (listener: () => void) => {
    store.listeners.add(listener)
    return () => { store.listeners.delete(listener) }
  }, [store])
  // reducer 只替换被事件命中的那个 key 的状态对象,别的 key 身份不变 ⇒ 快照不变 ⇒ 不重渲。
  const state = useSyncExternalStore(subscribe, () => (key ? store.map[key] : undefined))
  const lastEventAt = key ? store.lastEventAt[key] ?? 0 : 0
  return useMemo(() => (state ? { ...state, lastEventAt } : null), [state, lastEventAt])
}
