import { useCallback, useEffect, useRef, useState } from 'react'
import { readStoredAgentTurnFailures, type StoredAgentTurnFailure } from '../lib/storedAgentTurnFailures'
import { agentTurnFailureMuteKind, agentTurnFailureMuted, readAgentTurnFailureMutes, writeAgentTurnFailureMutes, type AgentTurnFailureMutes } from '../lib/agentTurnFailureMute'
import type { AgentTurnFailure } from '../lib/agentTurnFailure'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '../lib/realtimeChannel'
import { rendererLogger } from '../lib/log'
import { useAuth } from '../store/auth'

const log = rendererLogger('agent/stored-turn-failure')
const EMPTY: StoredAgentTurnFailure[] = []

function loadMutes(userId: string | undefined): AgentTurnFailureMutes {
  if (!userId) return {}
  try {
    return readAgentTurnFailureMutes(userId)
  } catch (error) {
    // 读坏了就等于没静音：提醒会照常出现，原因进日志，❌ 不让聊天面板崩。
    log.error({ error: String(error) }, 'could not read muted agent turn failures')
    return {}
  }
}
export const AGENT_DELIVER_CHANGED = 'agent_deliver_changed'

/** 宿主本机事件之外，从同一条命令的持久结果读失败；私有广播只提示失效，不广播错误原文。 */
export function useStoredAgentTurnFailure(chatId: string | null, threadRootId: string | null, agentIds: readonly string[]) {
  const { user } = useAuth()
  const ids = [...new Set(agentIds)].sort().join(',')
  const subject = JSON.stringify([user?.id, chatId, threadRootId, ids])
  const [snapshot, setSnapshot] = useState<{ subject: string; rows: StoredAgentTurnFailure[]; readFailed: boolean }>({ subject: '', rows: [], readFailed: false })
  const [attempt, setAttempt] = useState(0)
  const dismissed = useRef(new Map<string, string | null>())
  const [, rerender] = useState(0)
  const [mutes, setMutes] = useState<{ userId: string | undefined; value: AgentTurnFailureMutes }>(() => ({ userId: user?.id, value: loadMutes(user?.id) }))
  const currentMutes = mutes.userId === user?.id ? mutes.value : loadMutes(user?.id)

  useEffect(() => {
    if (!user?.id || !chatId || !ids) return
    let live = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void readStoredAgentTurnFailures(user.id, chatId, threadRootId, ids.split(',')).then(({ failures: rows, recovered }) => {
        if (!live || current !== generation) return
        // 每次补读都从存储取一次：别的聊天里关掉的静音这里也要认；最新一次投递成功的 Agent 解除静音。
        const stored = loadMutes(user.id)
        const next = { ...stored }
        for (const agentId of recovered) delete next[agentId]
        if (recovered.some((agentId) => agentId in stored)) writeAgentTurnFailureMutes(user.id, next)
        setMutes({ userId: user.id, value: next })
        for (const row of rows) if (dismissed.current.has(row.commandId) && dismissed.current.get(row.commandId) === null) dismissed.current.set(row.commandId, row.revision)
        setSnapshot({ subject, rows, readFailed: false })
      }).catch((error: unknown) => {
        if (!live || current !== generation) return
        log.error({ chatId, error: String(error) }, 'could not read agent reply outcome')
        setSnapshot((previous) => ({ subject, rows: previous.subject === subject ? previous.rows : [], readFailed: true }))
      })
    }
    const handle = subscribePrivateUserEventBus(user.id, AGENT_DELIVER_CHANGED, (raw) => {
      if (!raw || typeof raw !== 'object') return
      const event = raw as Record<string, unknown>
      if (event.chat_id !== chatId || (event.thread_root_id || null) !== threadRootId) return
      if (typeof event.agent_user_id !== 'string' || !ids.split(',').includes(event.agent_user_id)) return
      if (typeof event.id === 'string' && event.status !== 'error') dismissed.current.delete(event.id)
      refresh()
    }, { onSubscribed: refresh })
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', visible)
    refresh()
    return () => {
      live = false
      unsubscribePrivateUserEventBus(handle)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [user?.id, chatId, threadRootId, ids, subject, attempt])

  const rows = snapshot.subject === subject ? snapshot.rows : EMPTY
  const dismiss = useCallback((commandId: string) => {
    dismissed.current.set(commandId, rows.find((row) => row.commandId === commandId)?.revision ?? null)
    rerender((value) => value + 1)
  }, [rows])
  const mute = useCallback((failure: Pick<AgentTurnFailure, 'agentUserId' | 'rawMessage'>) => {
    const kind = agentTurnFailureMuteKind(failure.rawMessage)
    if (!user?.id || !kind) return
    const next = { ...loadMutes(user.id), [failure.agentUserId]: kind }
    writeAgentTurnFailureMutes(user.id, next)
    setMutes({ userId: user.id, value: next })
  }, [user?.id])
  const isMuted = useCallback((failure: Pick<AgentTurnFailure, 'agentUserId' | 'rawMessage'>) => agentTurnFailureMuted(currentMutes, failure), [currentMutes])
  return {
    failure: rows.find((row) => dismissed.current.get(row.commandId) !== row.revision && !isMuted(row)) ?? null,
    dismiss,
    mute,
    isMuted,
    readFailed: snapshot.subject === subject && snapshot.readFailed,
    retry: () => setAttempt((value) => value + 1),
  }
}
