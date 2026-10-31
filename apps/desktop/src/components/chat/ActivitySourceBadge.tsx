import { Button } from '../ui/Button'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import {OPEN_ASSISTANT_TASK_CHAT} from '../../lib/assistantTaskChat'
import {useAssistantWorkOwnerId} from '../../lib/assistantWorkReadBridge'
import {assistantWorkTarget} from '../../lib/assistantWorkTarget'
import {useAssistantWorkRecords} from '../assistant/assistant-work-records'
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink'

/** A small, factual association on the original request; never a synthetic progress or completion signal. */
export const ActivitySourceBadge = observer(function ActivitySourceBadge({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t } = useTranslation('assistant')
  const owner=useAssistantWorkOwnerId()
  const assistant = readAssistantShellBridge()?.getSnapshot()
  const {value}=useAssistantWorkRecords(assistant?.chatId===chatId?owner:null,assistant?.assistant?.id??'')
  if (!assistant?.assistant || assistant.chatId !== chatId) return null
  const tasks = (value?.records??[]).filter(work=>{
    const source = work.source_link?parseConversationLink(work.source_link):null
    return source?.chatId === chatId && source.messageId === messageId
  }).flatMap(work=>work.executors.map(executor=>assistantWorkTarget(work,executor.session_id)!))
  if (!tasks.length) return null
  return <span className="activity-source-links">
    {tasks.map((task) => <Button variant="ghost" size="sm" key={`${task.workId}:${task.task.sessionId}`}
      className="activity-source-link" title={task.title} aria-label={t('links.task', { title: task.title })}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:task}))}>
      <span aria-hidden="true">↗</span><span>{task.title}</span>
    </Button>)}
  </span>
})

import './agent-question-card.css'
