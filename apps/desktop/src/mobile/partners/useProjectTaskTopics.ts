import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { useTopicsOfChat } from '@/hooks/useTopics'
import { chatService } from '@/lib/chat'
import { useAuth } from '@/store/auth'
import { useChatStore } from '@/store/chatContext'

export type ProjectTaskTopic = { topic: TopicSummary; agentId: string; title: string }
const EMPTY_TASKS: ProjectTaskTopic[] = []

/** 从话题的来源卡认任务,不把任务话题再列成普通群。旧卡不在消息窗口里时也能认出来。 */
export function useProjectTaskTopics(chatId: string | null) {
  const { user } = useAuth()
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const subscribe = useCallback((listener: (ids: readonly string[]) => void) => subscribeAccountRevision('chat_changed', (operations) => listener(operations.flatMap((op) => {
    const id = (op.payload as { chat_id?: unknown } | null)?.chat_id
    return typeof id === 'string' ? [id] : []
  }))), [subscribeAccountRevision])
  const { topics, error: topicsError, loading: topicsLoading } = useTopicsOfChat(chatId, subscribe)
  const [state, setState] = useState<{ key: string; tasks: ProjectTaskTopic[]; error: boolean } | null>(null)
  const key = `${user?.id ?? ''}:${chatId ?? ''}:${topics.map((topic) => topic.source_message_id).join(',')}`
  useEffect(() => {
    if (!chatId || !user) return
    let cancelled = false
    Promise.all(topics.map(async (topic): Promise<ProjectTaskTopic | null> => {
      const source = await chatService.getMessageById(topic.source_message_id, user.id)
      const card = source?.content_type === 'card' ? parseComposerCard(source.content) : null
      return card?.type === 'task' ? { topic, agentId: card.agentUserId, title: card.text } : null
    })).then((rows) => {
      if (!cancelled) setState({ key, tasks: rows.filter((row): row is ProjectTaskTopic => row !== null), error: false })
    }, () => { if (!cancelled) setState({ key, tasks: [], error: true }) })
    return () => { cancelled = true }
  }, [key, chatId, user?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- key identifies the complete topic source set
  const tasks = state?.key === key ? state.tasks : EMPTY_TASKS
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.topic.chat_id)), [tasks])
  const byAgent = useMemo(() => {
    const result = new Map<string, ProjectTaskTopic>()
    for (const task of tasks) if (!result.has(task.agentId)) result.set(task.agentId, task)
    return result
  }, [tasks])
  return { tasks, taskIds, byAgent, loading: topicsLoading || (!!chatId && state?.key !== key), error: topicsError !== null || (state?.key === key && state.error) }
}
