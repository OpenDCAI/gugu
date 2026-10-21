import { useCallback, useEffect, useRef, useState } from 'react'
import { readStoredAgentTurnFailures, type StoredAgentTurnFailure } from '../lib/storedAgentTurnFailures'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '../lib/realtimeChannel'
import { rendererLogger } from '../lib/log'
import { useAuth } from '../store/auth'

const log = rendererLogger('agent/stored-turn-failure')
const EMPTY: StoredAgentTurnFailure[] = []
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

  useEffect(() => {
    if (!user?.id || !chatId || !ids) return
    let live = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void readStoredAgentTurnFailures(user.id, chatId, threadRootId, ids.split(',')).then((rows) => {
        if (!live || current !== generation) return
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
  return {
    failure: rows.find((row) => dismissed.current.get(row.commandId) !== row.revision) ?? null,
    dismiss,
    readFailed: snapshot.subject === subject && snapshot.readFailed,
    retry: () => setAttempt((value) => value + 1),
  }
}
