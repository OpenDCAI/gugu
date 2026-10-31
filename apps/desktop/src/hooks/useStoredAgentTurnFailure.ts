import { useCallback, useEffect, useState } from 'react'
import { readStoredAgentTurnFailures, type StoredAgentTurnFailure } from '../lib/storedAgentTurnFailures'
import { readAgentTurnFailureDismissals, writeAgentTurnFailureDismissals, type AgentTurnFailureDismissals } from '../lib/agentTurnFailureDismissals'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '../lib/realtimeChannel'
import { rendererLogger } from '../lib/log'
import { useAuth } from '../store/auth'

const log = rendererLogger('agent/stored-turn-failure')
const EMPTY: StoredAgentTurnFailure[] = []

function loadDismissals(userId: string | undefined): AgentTurnFailureDismissals {
  if (!userId) return {}
  try {
    return readAgentTurnFailureDismissals(userId)
  } catch (error) {
    // 读坏了就等于没关过：失败条再出现一次，原因进日志。
    log.error({ error: String(error) }, 'could not read dismissed agent turn failures')
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
  // 关掉记在本机存储里（按命令、按那一版），❌ 只记在组件里：切走再回来、重开 App 都还认得（owner 10-28 Codex 91）。
  const [dismissals, setDismissals] = useState<{ userId: string | undefined; value: AgentTurnFailureDismissals }>(() => ({ userId: user?.id, value: loadDismissals(user?.id) }))
  const currentDismissals = dismissals.userId === user?.id ? dismissals.value : loadDismissals(user?.id)
  const changeDismissals = useCallback((change: (now: AgentTurnFailureDismissals) => AgentTurnFailureDismissals | null) => {
    if (!user?.id) return
    const next = change(loadDismissals(user.id))
    if (!next) return
    try {
      writeAgentTurnFailureDismissals(user.id, next)
    } catch (error) {
      log.error({ error: String(error) }, 'could not save dismissed agent turn failures')
    }
    setDismissals({ userId: user.id, value: next })
  }, [user?.id])
  useEffect(() => {
    if (!user?.id || !chatId || !ids) return
    let live = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void readStoredAgentTurnFailures(user.id, chatId, threadRootId, ids.split(',')).then(({ failures: rows }) => {
        if (!live || current !== generation) return
        changeDismissals((now) => {
          const pending = rows.filter((row) => now[row.commandId]?.revision === null)
          return pending.length ? { ...now, ...Object.fromEntries(pending.map((row) => [row.commandId, { revision: row.revision, at: Date.now() }])) } : null
        })
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
      const settled = typeof event.id === 'string' && event.status !== 'error' ? event.id : null
      if (settled) changeDismissals((now) => {
        if (!(settled in now)) return null
        const rest = { ...now }
        delete rest[settled]
        return rest
      })
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
  }, [user?.id, chatId, threadRootId, ids, subject, attempt, changeDismissals])

  const rows = snapshot.subject === subject ? snapshot.rows : EMPTY
  const dismiss = useCallback((commandId: string) => {
    const revision = rows.find((row) => row.commandId === commandId)?.revision ?? null
    changeDismissals((now) => ({ ...now, [commandId]: { revision, at: Date.now() } }))
  }, [rows, changeDismissals])
  return {
    failure: rows.find((row) => currentDismissals[row.commandId]?.revision !== row.revision) ?? null,
    dismiss,
    readFailed: snapshot.subject === subject && snapshot.readFailed,
    retry: () => setAttempt((value) => value + 1),
  }
}
