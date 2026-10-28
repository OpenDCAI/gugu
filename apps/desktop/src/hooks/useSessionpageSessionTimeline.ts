import { useCallback, useEffect, useRef, useState } from 'react'
import { recentActionsFromTurns } from '@gugu/session-core/acp/client'
import type {
  RecordCursor,
  Settlement,
  SessionpageSessionRespondResult,
  TimelineAfterResult,
  TimelineSnapshot
} from '@gugu/session-core/session-record/contract'
import { settlementFromWire, type QuestionAnswer } from '@gugu/session-core/session-record/contract'
import { latestAgentQuestion } from '../lib/agentQuestion'
import { sessionpageSessionTimelineChannel } from '@/session/shared/core/session-timeline/sessionTimelineEvents'
import {
  sessionAgentStatusChangedChannel,
  sessionChangedChannel
} from '@/session/shared/core/sessions/sessionEvents'
import { rendererLogger } from '../lib/log'
import { desktopIpc } from '../platform/desktopIpc'

const timelineLog = rendererLogger('chat/sessionpage-session-timeline')

export type SessionpageRecentActions = {
  actions: string[]
  lastActionAt: string | null
}

/** 聊天页能从这条任务会话的时间线上读到、并当场作答的那一条审批。 */
export type SessionpagePendingPermission = {
  itemId: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
  /** 连同这一条在内还有几条在等。 */
  queueCount: number
  /** D-31 宿主替 agent 问的(装 App):按它自己的卡画,答案带上「给哪些 agent」。 */
  origin?: Settlement['origin']
}

export type SessionpageSessionTimeline = {
  recentActions: SessionpageRecentActions | null
  pendingPermission: SessionpagePendingPermission | null
  question: Settlement | null
  respondQuestion: (itemId: string, answers: readonly QuestionAnswer[]) => Promise<SessionpageSessionRespondResult>
  /** 经时间线的 `sessionRespond` 作答 —— 与手机、会话页同一条 CAS + resolvePermission 路径。 */
  /** `extra`: an App install's answer (D-31) — the fingerprint of the sheet shown, and where its tools are given. */
  respondPermission: (itemId: string, optionId: string, extra?: { digest?: string }) => Promise<SessionpageSessionRespondResult>
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error?: unknown }

function toIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value).toISOString()
}

function recentActionsFromSnapshot(snapshot: TimelineSnapshot): SessionpageRecentActions {
  if (Array.isArray(snapshot.recentActions)) {
    return {
      actions: snapshot.recentActions.filter(
        (action): action is string => typeof action === 'string'
      ),
      lastActionAt: toIso(snapshot.lastActionAt)
    }
  }
  const derived = recentActionsFromTurns(snapshot.turns)
  return {
    actions: derived.actions,
    lastActionAt: toIso(derived.lastActionAt)
  }
}

function pendingPermissionFrom(
  settlements: Readonly<Record<string, Settlement>>
): SessionpagePendingPermission | null {
  const pending = Object.values(settlements).filter(
    (settlement) =>
      settlement.state === 'pending' &&
      settlement.kind !== 'question' &&
      (settlement.options?.length ?? 0) > 0
  )
  const head = pending[0]
  if (!head) return null
  return {
    itemId: head.itemId,
    title: head.title ?? '',
    options: (head.options ?? []).map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind ?? ''
    })),
    queueCount: pending.length,
    ...(head.origin ? { origin: head.origin } : {})
  }
}

type TimelineFacts = {
  recentActions: SessionpageRecentActions | null
  settlements: Readonly<Record<string, Settlement>>
}

function indexSettlements(
  base: Readonly<Record<string, Settlement>>,
  settlements: readonly Settlement[]
): Record<string, Settlement> {
  const next = { ...base }
  for (const settlement of settlements) next[settlement.itemId] = settlementFromWire(settlement)
  return next
}

/** 这条会话的记录此刻还读不到,但会出现(会话刚建、provider 还没落下第一份记录)—— 不是错。 */
const RECORD_NOT_YET = new Set(['record_unsupported', 'record_not_found'])

/**
 * Read a mapped local task session through the same timeline RPC used by mobile:
 * recent actions for the header, and the pending permission the chat page must be able to answer.
 *
 * @@@record-not-yet 聊天页在 agent 一映射上就来读,而那一刻这条会话的记录常常还不在
 * (mac1 实测:映射 0.4s 时 `record_unsupported`、1.8s `record_not_found`、2.0s 才可读)。
 * 只读一次就放弃 ⇒ 新建的 agent 在聊天页永远拿不到审批入口和最近动作。
 * ⇒ 没接上时,**这条会话自己的事实一变**就再接一次:`session:changed`(provider 会话 id
 * 落下 —— 记录由它定位)与 `session:agent-status-changed`;接上之后不再理会。
 * ❌ 不拿定时器轮询去「等它出现」。
 */
export function useSessionpageSessionTimeline(sessionId: string | null): SessionpageSessionTimeline {
  const [state, setState] = useState<{
    sessionId: string | null
    value: TimelineFacts
  }>({ sessionId: null, value: { recentActions: null, settlements: {} } })
  const attachedRef = useRef<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const api = desktopIpc()
    if (!sessionId || !api) return
    const retry = (payload: unknown) => {
      if ((payload as { sessionId?: unknown } | null)?.sessionId !== sessionId) return
      if (attachedRef.current !== sessionId) setAttempt((n) => n + 1)
    }
    const stops = [sessionChangedChannel.name, sessionAgentStatusChangedChannel.name].map(
      (channel) => api.eventOn(channel, retry)
    )
    return () => {
      for (const stop of stops) stop()
    }
  }, [sessionId])

  useEffect(() => {
    attachedRef.current = null
    const api = desktopIpc()
    if (!sessionId || !api) {
      setState({ sessionId, value: { recentActions: null, settlements: {} } })
      return
    }

    setState({ sessionId, value: { recentActions: null, settlements: {} } })
    let alive = true
    let cursor: RecordCursor | null = null
    let stopEvents: (() => void) | null = null
    const subscriptionId = globalThis.crypto?.randomUUID?.()
    if (!subscriptionId)
      throw new Error('crypto.randomUUID is required for sessionpage timeline subscription')

    const commitSnapshot = (snapshot: TimelineSnapshot) => {
      if (!alive) return
      cursor = snapshot.cursor
      setState({
        sessionId,
        value: {
          recentActions: recentActionsFromSnapshot(snapshot),
          settlements: indexSettlements({}, snapshot.settlements)
        }
      })
    }

    const onResult = (result: TimelineAfterResult) => {
      if (!alive) return
      if (!result.ok) {
        commitSnapshot(result.snapshot)
        return
      }
      const { batch } = result
      cursor = batch.cursor
      setState((prev) => {
        if (prev.sessionId !== sessionId) return prev
        return {
          sessionId,
          value: {
            // Older hosts may send a transcript-only batch. Keep the presence projection
            // until a timeline payload actually carries its own summary fields.
            recentActions:
              batch.recentActions === undefined || batch.lastActionAt === undefined
                ? prev.value.recentActions
                : { actions: batch.recentActions, lastActionAt: toIso(batch.lastActionAt) },
            // 增量里的结算按 itemId 替换(与手机 agent-watch-store 同一合并规则)。
            settlements: indexSettlements(prev.value.settlements, batch.settlements)
          }
        }
      })
    }

    // Listen before opening the subscription so a provider update between the
    // snapshot and subscribe calls cannot disappear from the desktop surface.
    stopEvents = api.eventOn(`${sessionpageSessionTimelineChannel.name}.${subscriptionId}`, (payload) => {
      const result = (payload as { result?: unknown } | null)?.result
      if (result && typeof result === 'object') onResult(result as TimelineAfterResult)
    })

    const load = async () => {
      try {
        const raw = (await api.invoke('sessionTimeline.sessionSnapshot', {
          conversationId: sessionId,
          limit: 50
        })) as RpcResult<TimelineSnapshot>
        if (!alive || !raw) return
        if (raw.ok !== true) {
          const code = (raw.error as { code?: unknown } | undefined)?.code
          // 记录还没落下 ⇒ 等下一次状态变化再接;不在这台机器上(session_not_found)⇒ presence 兜着。
          if (typeof code === 'string' && (RECORD_NOT_YET.has(code) || code === 'session_not_found')) return
          throw new Error(`sessionSnapshot refused: ${JSON.stringify(raw.error ?? null)}`)
        }
        commitSnapshot(raw.value)
        const subscribed = (await api.invoke('sessionTimeline.sessionSubscribe', {
          conversationId: sessionId,
          subscriptionId,
          cursor: cursor ?? raw.value.cursor
        })) as RpcResult<unknown>
        if (!alive) { await api.invoke('sessionTimeline.sessionUnsubscribe', { subscriptionId }); return }
        if (!subscribed) return
        if (subscribed.ok !== true) throw new Error(`sessionSubscribe refused: ${JSON.stringify(subscribed.error ?? null)}`)
        attachedRef.current = sessionId
      } catch (error) {
        // Presence remains the explicit cross-device fallback for status when the local
        // session record is unavailable or this host predates the RPC. But a snapshot
        // without live updates must not keep offering an approval: nothing would ever
        // clear it once another surface answers, so drop the pending band and say why.
        timelineLog.error(
          { sessionId, error: error instanceof Error ? error.message : String(error) },
          'sessionpage session timeline unavailable'
        )
        if (!alive) return
        setState((prev) =>
          prev.sessionId === sessionId
            ? { sessionId, value: { ...prev.value, settlements: {} } }
            : prev
        )
      }
    }
    void load()

    return () => {
      alive = false
      stopEvents?.()
      void api
        .invoke('sessionTimeline.sessionUnsubscribe', { subscriptionId })
        .catch(() => undefined)
    }
  }, [sessionId, attempt])

  const respondPermission = useCallback(
    async (itemId: string, optionId: string, extra?: { digest?: string }): Promise<SessionpageSessionRespondResult> => {
      const api = desktopIpc()
      if (!sessionId || !api) throw new Error('sessionpage session timeline is unavailable')
      const raw = (await api.invoke('sessionTimeline.sessionRespond', {
        conversationId: sessionId,
        itemId,
        optionId,
        ...(extra?.digest ? { digest: extra.digest } : {}),
        kind: 'permission',
        by: 'desktop'
      })) as RpcResult<SessionpageSessionRespondResult>
      if (!raw || raw.ok !== true) {
        const error = raw && 'error' in raw ? raw.error : undefined
        throw new Error(
          typeof error === 'object' && error && 'message' in error
            ? String((error as { message: unknown }).message)
            : String(error ?? 'sessionRespond failed')
        )
      }
      return raw.value
    },
    [sessionId]
  )

  const facts = state.sessionId === sessionId ? state.value : null
  const respondQuestion = useCallback(async (itemId: string, answers: readonly QuestionAnswer[]) => {
    const api = desktopIpc()
    if (!sessionId || !api) throw new Error('Session question transport is unavailable')
    const raw = await api.invoke('sessionTimeline.sessionRespond', { conversationId: sessionId, itemId, kind: 'question', answers, by: 'desktop' }) as RpcResult<SessionpageSessionRespondResult>
    if (!raw?.ok) throw new Error('Question answer could not be delivered')
    return raw.value
  }, [sessionId])
  return {
    recentActions: facts?.recentActions ?? null,
    pendingPermission: facts ? pendingPermissionFrom(facts.settlements) : null,
    question: facts ? latestAgentQuestion(facts.settlements) : null,
    respondQuestion,
    respondPermission
  }
}
