import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { readAssistantTaskChat, subscribeAssistantTaskChats } from '../../lib/assistantTaskChat'
import { startTaskExchangeReader } from '../../lib/taskExchangeReader'
import type { TaskExchange } from '../../session/shared/core/sessions/task-collaboration'
import { useDevicesStore } from '../../store/devicesContext'
import { taskExchangeTransport } from './taskExchangeTransport'
import { taskChatRows, taskChatWindow } from './taskChatRows'
import { Button } from '../ui/Button'
import { rendererLogger } from '../../lib/log'
import './assistant-task-chat.css'

const log = rendererLogger('assistant/task-chat')

const cache = new Map<string, TaskExchange[]>()
const EMPTY: TaskExchange[] = []

export function useTaskChatRows(messages: readonly MessageItem[], ownerId: string | undefined, agentId: string | null | undefined, visible: boolean, query: string) {
  const task = useSyncExternalStore(subscribeAssistantTaskChats, () => readAssistantTaskChat(ownerId, agentId))
  const { devices } = useDevicesStore()
  const { t } = useTranslation('assistant')
  const key = task ? JSON.stringify([ownerId, task]) : ''
  const [projection, setProjection] = useState<{ key: string; entries: TaskExchange[] } | null>(null)
  const [history, setHistory] = useState({ key: '', count: 80 })
  const [status, setStatus] = useState<{ key: string; states: string[] }>({ key: '', states: [] })
  // 人按「重试」+1:同一组端点从头再订一遍(已读到的留在 cache 里照常画,补齐靠 id 去重)。
  const [attempt, setAttempt] = useState(0)
  const localId = devices.find((device) => device.is_current_device)?.device_id
  // A presence heartbeat with the same reachability must not tear down and replay the history.
  const online = task ? [task.task, ...task.assistants].map((end) => devices.find((device) => device.device_id === end.deviceId)?.is_online === true).join(',') : ''
  useEffect(() => {
    if (!task || !visible) return
    let cancelled = false
    const stops: (() => void)[] = []
    const legs = task.assistants.flatMap((assistant) => [
      { recipient: task.task, sender: assistant }, { recipient: assistant, sender: task.task },
    ])
    const states = legs.map(() => 'loading')
    const report = () => { if (!cancelled) setStatus({ key, states: [...states] }) }
    report()
    legs.forEach((leg, index) => {
      const local = leg.recipient.deviceId === localId
      if (!local && !devices.find((device) => device.device_id === leg.recipient.deviceId)?.is_online) { states[index] = 'unavailable'; report(); return }
      void taskExchangeTransport(leg.recipient.deviceId, local).then((transport) => {
        if (cancelled) return
        stops.push(startTaskExchangeReader(transport, { conversationId: leg.recipient.sessionId, fromSessionId: leg.sender.sessionId }, (entries) => {
          if (cancelled || entries.length === 0) return
          const merged = new Map((cache.get(key) ?? []).map((entry) => [entry.id, entry]))
          for (const entry of entries) merged.set(entry.id, entry)
          const nextEntries = [...merged.values()]
          cache.set(key, nextEntries)
          setProjection({ key, entries: nextEntries })
        }, (value, error) => {
          if (value === 'unavailable' && error !== undefined) log.warn({ error: String((error as Error)?.message ?? error), deviceId: leg.recipient.deviceId, conversationId: leg.recipient.sessionId }, 'task collaboration read failed')
          states[index] = value; report()
        }))
      }).catch((error: unknown) => {
        log.warn({ error: String((error as Error)?.message ?? error), deviceId: leg.recipient.deviceId }, 'task collaboration transport unavailable')
        states[index] = 'unavailable'; report()
      })
    })
    return () => { cancelled = true; for (const stop of stops) stop() }
    // These strings describe the endpoints and their reachability, not the device row object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, online, localId, attempt])
  const exchanges = projection?.key === key ? projection.entries : cache.get(key) ?? EMPTY
  const allRows = useMemo(() => taskChatRows(messages, exchanges, task, query), [messages, exchanges, task, query])
  const count = query ? Infinity : history.key === key ? history.count : 80
  const { rows, earlier } = useMemo(() => taskChatWindow(allRows, count), [allRows, count])
  const listedMessages = useMemo(() => rows.map((row) => row.message), [rows])
  const states = status.key === key ? status.states : []
  const unavailable = states.includes('unavailable')
  const notice = !task ? null : <div role="status" data-testid="task-collaboration-status" className="task-chat-notice">
    {task.assistants.length === 0 || unavailable ? t('tasks.collaborationUnavailable')
      : states.length === 0 || states.includes('loading') ? t('tasks.collaborationLoading') : t('tasks.collaborationReady')}
    {unavailable && <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)} data-testid="task-collaboration-retry">{t('machine.retry')}</Button>}
    {earlier > 0 && <Button variant="ghost" size="sm" onClick={() => setHistory({ key, count: count + 80 })}>{t('tasks.collaborationOlder')}</Button>}
  </div>
  return { rows, listedMessages, notice, threeParty: task !== null }
}
