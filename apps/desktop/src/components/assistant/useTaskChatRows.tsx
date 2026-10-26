import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { readAssistantTaskChat, subscribeAssistantTaskChats } from '../../lib/assistantTaskChat'
import type { TaskExchange } from '../../session/shared/core/sessions/task-collaboration'
import { assistantWorkCloud,watchAssistantWork } from '../../lib/assistantWork'
import { assistantWorkExchanges } from './assistant-work-projection'
import { taskChatRows, taskChatWindow } from './taskChatRows'
import { Button } from '../ui/Button'
import { rendererLogger } from '../../lib/log'
import './assistant-task-chat.css'

const log = rendererLogger('assistant/task-chat')

const cache = new Map<string, TaskExchange[]>()
const EMPTY: TaskExchange[] = []

export function useTaskChatRows(messages: readonly MessageItem[], ownerId: string | undefined, agentId: string | null | undefined, visible: boolean, query: string) {
  const task = useSyncExternalStore(subscribeAssistantTaskChats, () => readAssistantTaskChat(ownerId, agentId))
  const { t } = useTranslation('assistant')
  const key = task ? JSON.stringify([ownerId,task]) : ''
  const [projection,setProjection] = useState<{ key: string; entries: TaskExchange[] } | null>(null)
  const [history,setHistory] = useState({ key: '',count: 80 })
  useEffect(() => {
    if (!task || !ownerId || !visible) return
    let alive = true,version = 0,failures = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      clearTimeout(retry)
      const current = ++version
      try {
        const workIds=task.workId ? [task.workId] : (await assistantWorkCloud.listAll(task.assistantId))
          .filter(work=>work.executors.some(target=>target.session_id===task.task.sessionId && target.device_id===task.task.deviceId)
            && task.assistants.some(home=>home.sessionId===work.coordinator_session_id && home.deviceId===work.coordinator_device_id)).map(work=>work.work_id)
        const pages=await Promise.all(workIds.map(async workId=>assistantWorkExchanges(await assistantWorkCloud.historyAll(task.assistantId,workId),workId)))
        if (!alive || current !== version) return
        // Replace, rather than merge, so deleted original sources disappear after revalidation.
        const entries=pages.flat()
        failures = 0
        cache.set(key,entries)
        setProjection({ key,entries })
      } catch (error) {
        if (alive && current === version) {
          log.warn({ error },'account collaboration read failed')
          retry=setTimeout(()=>{void refresh()},Math.min(30_000,1000 * 2 ** Math.min(5,failures++)))
        }
      }
    }
    const stop = watchAssistantWork(ownerId,task.assistantId,() => { void refresh() })
    void refresh()
    return () => { alive = false; clearTimeout(retry); stop() }
  },[key,visible,ownerId,task])
  const exchanges = projection?.key === key ? projection.entries : cache.get(key) ?? EMPTY
  const allRows = useMemo(() => taskChatRows(messages, exchanges, task, query), [messages, exchanges, task, query])
  const count = query ? Infinity : history.key === key ? history.count : 80
  const { rows, earlier } = useMemo(() => taskChatWindow(allRows, count), [allRows, count])
  const listedMessages = useMemo(() => rows.map((row) => row.message), [rows])
  const notice = earlier > 0 ? <div className="task-chat-notice"><Button variant="ghost" size="sm"
    onClick={() => setHistory({ key,count: count + 80 })}>{t('tasks.collaborationOlder')}</Button></div> : null
  return { rows, listedMessages, notice, threeParty: task !== null }
}
