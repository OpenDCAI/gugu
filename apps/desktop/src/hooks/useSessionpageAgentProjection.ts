import { useEffect, useState } from 'react'
import {
  parsePlatformRecovery,
  parseSessionpageAgentContext,
  type SessionpageAgentContext,
} from '../lib/sessionpageAgentProjection'
import { desktopIpc } from '../platform/desktopIpc'

// @@@3911 投影自带主体 —— 一份投影只描述 `agentUserId` 这一个 agent,任何时刻都能自证它说的是谁。
// 这不是多余的冗余字段:本 hook 的 state 只能在 effect 里跟随入参,而 effect 落在 paint 之后 ⇒
// 换 agent 的那一帧,state 必然还是**上一个 agent** 的。没有主体就无从判断这一点,而消费方
// (AgentSessionpagePresentation)会把上一个 agent 的会话入口、恢复条挂到新 agent 的 DM 上。
// owner 报的「点过运行中的 agent 再点闲置 agent,闲置的也变运行中」就是这么来的(#3911)。
//
// 这份投影只答「这个 agent 映射到会话页哪条会话」与只在会话面显形的平台恢复。它的状态、审阅门、provider
// 阻塞是宿主按 agent 的流里的读数(agentPresenceStore 的 `local`),❌ 在这里再订一遍会话页的按会话通道 ——
// 同一件事两条通道,就会给出两个答案。
type ProjectionSubject = { agentUserId: string | null }

type ProjectionState = (
  | { kind: 'disabled' | 'pending' | 'unmapped'; context: null; error: null }
  | { kind: 'mapped'; context: SessionpageAgentContext; error: null }
  | { kind: 'error'; context: SessionpageAgentContext | null; error: string }
) & ProjectionSubject

const DISABLED: ProjectionState = { kind: 'disabled', context: null, error: null, agentUserId: null }

/** 「关于这个 agent，我还什么都不知道」。❌ 不是「上一个 agent 的答案先顶着」。 */
function unknownFor(agentUserId: string | null): ProjectionState {
  return agentUserId === null ? DISABLED : { kind: 'pending', context: null, error: null, agentUserId }
}

export function useSessionpageAgentProjection(agentUserId: string | null): ProjectionState {
  const [state, setState] = useState<ProjectionState>(DISABLED)

  useEffect(() => {
    const api = desktopIpc()
    if (!agentUserId || !api) {
      setState({ ...DISABLED, agentUserId: agentUserId ?? null })
      return
    }

    let alive = true
    let resolvedContext: SessionpageAgentContext | null = null
    setState({ kind: 'pending', context: null, error: null, agentUserId })

    // 任务页换了展示(编程 ⇄ 通用):宿主播 session:changed,带 runtime。私聊头部模式按钮的「使用中」跟着换,
    // ❌ 等下一次打开私聊才对 —— 换完回到聊天页,那一行就得已经是新的那种。
    const unsubscribeView = api.eventOn('session:changed', (value) => {
      if (!value || typeof value !== 'object') return
      const event = value as { sessionId?: unknown; projectId?: unknown; changes?: { runtime?: unknown } }
      const runtime = event.changes?.runtime
      if (!alive || !resolvedContext || runtime === undefined) return
      if (event.sessionId !== resolvedContext.sessionId || event.projectId !== resolvedContext.projectId) return
      resolvedContext = { ...resolvedContext, view: runtime === 'acp' ? 'general' : 'code' }
      const context = resolvedContext
      setState((current) => (current.context ? { ...current, context } : current))
    })

    const unsubscribeRecovery = api.eventOn('session:platform-recovery-changed', (value) => {
      if (!value || typeof value !== 'object') return
      const event = value as Record<string, unknown>
      const recovery = parsePlatformRecovery(event)
      const sameTarget = resolvedContext
        && event.projectId === resolvedContext.projectId
        && event.conversationId === resolvedContext.sessionId
      if (alive && resolvedContext && sameTarget) {
        resolvedContext = { ...resolvedContext, platformRecovery: recovery }
        setState({ kind: 'mapped', context: resolvedContext, error: null, agentUserId })
      }
    })

    void api.invoke('sessionpage:agent-context', agentUserId).then((value) => {
      if (!alive) return
      const context = parseSessionpageAgentContext(value)
      resolvedContext = context
      if (!context) {
        setState({ kind: 'unmapped', context: null, error: null, agentUserId })
        return
      }
      if (context.projectionError) {
        setState({ kind: 'error', context, error: context.projectionError, agentUserId })
        return
      }
      setState({ kind: 'mapped', context, error: null, agentUserId })
    }).catch((error: unknown) => {
      if (!alive) return
      const message = error instanceof Error ? error.message : String(error)
      setState({ kind: 'error', context: resolvedContext, error: message, agentUserId })
    })

    return () => {
      alive = false
      unsubscribeView()
      unsubscribeRecovery()
    }
  }, [agentUserId])

  // @@@3911 主体不符 = 这份 state 描述的是上一个 agent,对当前这个 agent 我们还没有答案。
  // 交出去的话,消费方会给它盖上当前 agent 的身份。所以这里回答「还不知道」,而不是回答别人的答案。
  return state.agentUserId === agentUserId ? state : unknownFor(agentUserId)
}
