import { useCallback, useEffect, useMemo, useState } from 'react'
import { chatService } from '../lib/chat'
import { useToast } from '../components/toastContext'
import {
  getAgentPresenceSnapshot,
  neverObservedAgentPresence,
  subscribeAgentPresence,
  type AgentPresenceState,
} from '../lib/agentPresenceStore'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { i18n } from '@/i18n'

// 这些 hook 是那张 agent 状态表的**选择器**,一个 agent 一个答案 —— ❌ 没有「按会话」这一维:
// 从前这里把 store 的态按 presence.activeChatId 再收口一次,于是权威点名了哪条会话,
// 只有那一面说真话、其余每一面说空闲(owner 2026-09-11 报的「群里工作中、单聊空闲」)。

// @@@unified-presence-hook - Thin selector over AgentPresenceStore. The store handles transport, fusion,

// @@@3839 C — 单数与批量 hook 走**同一条**初始化路径:两者都在 useState 的 initializer 里读 store。
// 只在 useEffect 里读会让暖缓存也先画一帧 `确认中`(passive effect 在 paint 之后才跑),而那一帧与
// 「真的从未观测过」在屏幕上一模一样 —— 用户分不出,判据也分不出。
// 「没观测过长什么样」由 store 单点定义,这里 ❌ 不留第二份字面量(原 emptyState 就是那份副本)。
function initialPresenceState(agentUserId: string | null | undefined): AgentPresenceState {
  if (!agentUserId) return neverObservedAgentPresence('')
  return getAgentPresenceSnapshot(agentUserId) ?? neverObservedAgentPresence(agentUserId)
}

export function useAgentDisplayStatus(agentUserId: string | null | undefined) {
  const { toast } = useToast()
  const [state, setState] = useState<AgentPresenceState>(() => initialPresenceState(agentUserId))
  const [trackedAgentUserId, setTrackedAgentUserId] = useState(agentUserId)
  const [opening, setOpening] = useState(false)

  // @@@3839 换 agent 时在**渲染期**换掉 state(React 的 adjust-state-on-prop-change),不在 effect 里补一刀:
  // effect 那一刀会让 store 在挂载时被读两次(initializer 一次、effect 一次),两次读之间的任何变化都会
  // 让首帧与次帧不一致;而在 effect 落地之前,组件还会顶着**上一个 agent** 的状态渲染一帧。
  if (trackedAgentUserId !== agentUserId) {
    setTrackedAgentUserId(agentUserId)
    setState(initialPresenceState(agentUserId))
  }

  useEffect(() => {
    if (!agentUserId) return
    return subscribeAgentPresence(agentUserId, setState)
  }, [agentUserId])

  // @@@acp-no-wake (#1099) - ACP 下 agent = spawn+stdio,设备在线即可触达、发消息自动启动该会话;
  // 不存在 terminal 时代「先唤醒再用」的机制。原 wake() 动作 + chatService.wakeAgent 已删。
  const openRuntime = useCallback(async () => {
    if (!agentUserId || opening) return
    setOpening(true)
    try {
      await chatService.openAgentRuntime(agentUserId)
      toast(i18n.t('chatService.runtimeOpen.opened', { ns: 'messaging' }), 'info')
    } catch (err) {
      toast(String((err as Error)?.message ?? err), 'error')
    } finally {
      setOpening(false)
    }
  }, [agentUserId, opening, toast])

  return {
    status: state.status,
    presence: state,
    opening,
    openRuntime,
  }
}

// @@@batched-presence-hook - One stable subscription per agent ID; aggregated map for surfaces that render N agents.
// Used by group panel and any future chat-list badges. Re-subscribes only when the ID set changes.
export function useAgentDisplayStatuses(
  agentUserIds: readonly string[],
): Record<string, AgentDisplayStatus> {
  // @@@stable-ids-key (#514) - derive the subscription key from the agent-id VALUES, not the input
  const idsKey = useMemo(
    () => Array.from(new Set(agentUserIds.filter(Boolean))).sort().join(','),
    [agentUserIds],
  )
  const stableIds = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])
  const [statuses, setStatuses] = useState<Record<string, AgentDisplayStatus>>(() => {
    const initial: Record<string, AgentDisplayStatus> = {}
    for (const id of stableIds) {
      const snapshot = getAgentPresenceSnapshot(id)
      if (snapshot && snapshot.source !== 'pending') initial[id] = snapshot.status
    }
    return initial
  })

  useEffect(() => {
    if (stableIds.length === 0) {
      setStatuses((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    setStatuses((prev) => {
      const next: Record<string, AgentDisplayStatus> = {}
      for (const id of stableIds) {
        const snapshot = getAgentPresenceSnapshot(id)
        if (snapshot && snapshot.source !== 'pending') next[id] = snapshot.status
      }
      return Object.keys(prev).toString() === Object.keys(next).toString() && Object.entries(next).every(([key, status]) => prev[key] === status) ? prev : next
    })
    const unsubs = stableIds.map((id) =>
      subscribeAgentPresence(id, (state) => {
        // Batch consumers are aggregate/group surfaces. Pending is not a resolved member state, so
        // keep it absent until a snapshot/event arrives instead of flashing a false group dot.
        if (state.source === 'pending') {
          setStatuses((prev) => {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          })
          return
        }
        setStatuses((prev) => (prev[id] === state.status ? prev : { ...prev, [id]: state.status }))
      }),
    )
    return () => {
      for (const off of unsubs) off()
    }
  }, [idsKey, stableIds])

  return statuses
}

// @@@group-recent-activity (#518/#437) - per-agent recent-action data for the avatar pop-out (group bar +
export interface AgentRecentActivity {
  actions: string[]
  lastActiveAt: string | null
}

export function useAgentRecentActivity(
  agentUserIds: readonly string[],
): Record<string, AgentRecentActivity> {
  const idsKey = useMemo(
    () => Array.from(new Set(agentUserIds.filter(Boolean))).sort().join(','),
    [agentUserIds],
  )
  const stableIds = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])
  const [activity, setActivity] = useState<Record<string, AgentRecentActivity>>(() => {
    const initial: Record<string, AgentRecentActivity> = {}
    for (const id of stableIds) {
      const payload = getAgentPresenceSnapshot(id)?.payload
      initial[id] = { actions: payload?.recentActions ?? [], lastActiveAt: payload?.lastActionAt ?? null }
    }
    return initial
  })

  useEffect(() => {
    if (stableIds.length === 0) {
      setActivity({})
      return
    }
    setActivity((prev) => {
      const next: Record<string, AgentRecentActivity> = {}
      for (const id of stableIds) {
        const payload = getAgentPresenceSnapshot(id)?.payload
        next[id] = payload
          ? { actions: payload.recentActions ?? [], lastActiveAt: payload.lastActionAt ?? null }
          : prev[id] ?? { actions: [], lastActiveAt: null }
      }
      return next
    })
    const unsubs = stableIds.map((id) =>
      subscribeAgentPresence(id, (state) => {
        const next: AgentRecentActivity = {
          actions: state.payload?.recentActions ?? [],
          lastActiveAt: state.payload?.lastActionAt ?? null,
        }
        setActivity((prev) => (sameActivity(prev[id], next) ? prev : { ...prev, [id]: next }))
      }),
    )
    return () => {
      for (const off of unsubs) off()
    }
  }, [idsKey, stableIds])

  return activity
}

function sameActivity(a: AgentRecentActivity | undefined, b: AgentRecentActivity): boolean {
  if (!a || a.lastActiveAt !== b.lastActiveAt) return false
  return sameSeq(a.actions, b.actions)
}

function sameSeq(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
