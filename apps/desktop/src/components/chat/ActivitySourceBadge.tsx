import { Button } from '../ui/Button'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useChatStore } from '@/store/chatContext'
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
  const tasks = (value?.records??[]).filter(work=>{
    const source = work.source_link?parseConversationLink(work.source_link):null
    return source?.chatId === chatId && source.messageId === messageId
  }).flatMap(work=>work.executors.map(executor=>assistantWorkTarget(work,executor.session_id)!))
  const {identitiesById}=useChatStore('identitiesById')
  const names=useShownAgentName(tasks.map(task=>({name:task.title??'',createdAt:identitiesById[task.taskAgentId??'']?.created_at??undefined})))
  if (!assistant?.assistant || assistant.chatId !== chatId) return null
  if (!tasks.length) return null
  return <span className="activity-source-links">
    {tasks.map((task,index) => <Button variant="ghost" size="sm" key={`${task.workId}:${task.task.sessionId}`}
      className="activity-source-link" title={names[index]} aria-label={t('links.task', { title: names[index] })}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:task}))}>
      <span aria-hidden="true">↗</span><span>{names[index]}</span>
    </Button>)}
  </span>
})

import './agent-question-card.css'
