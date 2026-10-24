import { Button } from '../ui/Button'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { openAssistantTaskChat } from '../../lib/assistantTaskChat'
import { useDevicesStore } from '../../store/devicesContext'
import { localHomeSessions } from '../../session/renderer/features/assistant/assistant-home-sessions'
import { remoteHostsStore } from '../../session/renderer/features/remote-hosts/remote-hosts-store'
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink'

/** A small, factual association on the original request; never a synthetic progress or completion signal. */
export const ActivitySourceBadge = observer(function ActivitySourceBadge({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t } = useTranslation('assistant')
  const { devices } = useDevicesStore()
  const assistant = readAssistantShellBridge()?.getSnapshot()
  if (!assistant?.assistant || assistant.chatId !== chatId) return null
  const deviceId = devices.find((device) => device.is_current_device)?.device_id
  const listed = [...remoteHostsStore.allListedSessions(), ...(deviceId ? localHomeSessions.sessions.map((summary) => ({ deviceId, summary, live: localHomeSessions.loaded })) : [])]
  const tasks = listed.filter((item) => item.summary.agent && item.summary.agent.userId !== assistant.assistant!.id && item.summary.activitySourceLinks?.some((href) => {
    const source = parseConversationLink(href)
    return source?.chatId === chatId && source.messageId === messageId
  }))
  if (!tasks.length) return null
  return <span className="activity-source-links">
    {tasks.map((task) => <Button variant="ghost" size="sm" key={`${task.deviceId}:${task.summary.conversationId}`}
      className="activity-source-link" title={task.summary.title} aria-label={t('links.task', { title: task.summary.title })}
      onClick={() => openAssistantTaskChat(assistant.assistant!.id, task, listed)}>
      <span aria-hidden="true">↗</span><span>{task.summary.title}</span>
    </Button>)}
  </span>
})

import './agent-question-card.css'
