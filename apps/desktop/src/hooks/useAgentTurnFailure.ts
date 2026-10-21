// #2115 订阅普通 ACP 回合的终态失败（agent-stream error + commandId），返回当前 (chat,thread) 作用域的
// 失败条。累积/清除逻辑在纯 reducer agentTurnFailure 里（已单测）；本 hook 只做事件桥接与作用域取值，
// 结构对齐 useAgentStream（同一事件源、同一 key 刻度）。

import { useCallback, useEffect, useState } from 'react'
import type { AgentStreamPayload } from '@gugu/core/shared/types/agentStream'
import { UI_EVENTS } from '../lib/uiEvents'
import { agentStreamKey } from '../lib/agentStreamState'
import { reduceAgentTurnFailures, type AgentTurnFailure, type AgentTurnFailureMap } from '../lib/agentTurnFailure'

export function useAgentTurnFailure(
  conversationId: string | null | undefined,
  threadRootId: string | null | undefined,
): { failure: AgentTurnFailure | null; dismiss: () => void } {
  const [map, setMap] = useState<AgentTurnFailureMap>({})

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as AgentStreamPayload | undefined
      if (!detail || typeof detail.conversationId !== 'string' || typeof detail.agentUserId !== 'string') return
      if (detail.event.type === 'error' && detail.event.commandId) {
        // fail loud：原始错误进 renderer console，失败条同时提供悬浮详情。
        console.error(
          `[agent-turn] turn failed (agent=${detail.agentUserId} chat=${detail.conversationId} thread=${detail.threadRootId ?? 'main'} command=${detail.event.commandId}): ${detail.event.message}`,
        )
      }
      setMap((prev) => reduceAgentTurnFailures(prev, detail, Date.now()))
    }
    window.addEventListener(UI_EVENTS.agentStream, handler)
    return () => window.removeEventListener(UI_EVENTS.agentStream, handler)
  }, [])

  const key = conversationId ? agentStreamKey(conversationId, threadRootId ?? null) : null
  const failure = key ? (map[key] ?? null) : null

  const dismiss = useCallback(() => {
    if (!key) return
    setMap((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [key])

  return { failure, dismiss }
}
