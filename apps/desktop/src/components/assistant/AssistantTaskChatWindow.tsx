import { useEffect,useRef,type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { ChatAreaPanel } from '../ChatAreaPanel'
import { Avatar } from '../Avatar'
import { PaneHeader } from '../ui/Pane'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { ChevronLeft, Plus, Search } from '../../lib/icons'
import { LoadingIndicator } from '../../lib/loading/LoadingIndicator'
import { UI_EVENTS } from '../../lib/uiEvents'
import { scheduleComposerFocus } from '../../lib/focusComposer'
import { useReportChatOnScreen } from '../../lib/onScreenChat'
import { useMobileShell } from '../../hooks/useMobileShell'
import { useAssistantDm } from './useAssistantDm'
import type { AssistantChatHandlers } from './AssistantChatSlot'
import { assistantSlotKey } from '../../lib/assistantShellBridge'
import { TaskChatScope } from './TaskChatScope'
import { TaskChatFilePreviewHost } from './TaskChatFilePreviewHost'
import './assistant-task-chat.css'

/** The task pane's own conversation, alongside the personal assistant. */
export function AssistantTaskChatWindow({ agent, onClose,status,notice,pendingContent,runtimeReady, ...handlers }: {
  agent: Pick<ContactUser, 'id' | 'display_name' | 'avatar'>
  onClose: () => void
  status?:string
  notice?:ReactNode
  pendingContent?:ReactNode
  runtimeReady?:boolean
} & AssistantChatHandlers) {
  const { t } = useTranslation('assistant')
  const mobile = useMobileShell()
  const dm = useAssistantDm(agent.id)
  const failures=useRef(0),retry=useRef(dm.retry)
  retry.current=dm.retry
  const waitingOnDm=!!pendingContent&&!dm.chatId&&!!dm.failed
  useEffect(()=>{failures.current=0},[agent.id])
  useEffect(()=>{
    if(!waitingOnDm||failures.current>=2)return
    const timer=setTimeout(()=>{failures.current++;retry.current()},1500)
    return()=>clearTimeout(timer)
  },[waitingOnDm,dm.failed?.error,agent.id])
  useReportChatOnScreen(dm.chatId)
  useEffect(() => dm.chatId ? scheduleComposerFocus('chat-entry', { mobileShell: mobile }) : undefined, [dm.chatId, mobile])
  return (
      <section className="assistant-task-chat-window ta-skin" aria-label={agent.display_name} data-testid="assistant-task-chat-window">
        <TaskChatFilePreviewHost mobile={mobile}><PaneHeader title={agent.display_name} subtitle={status} mobile={mobile} divider
          leading={<><IconButton aria-label={t('panel.back')} onClick={onClose} data-testid="assistant-task-chat-close"><ChevronLeft /></IconButton><Avatar name={agent.display_name} seed={agent.id} avatarUrl={agent.avatar} size="sm" isAgent still harnessBadge={false} /></>}
          actions={<>
            {dm.chatId && <IconButton aria-label={t('top.search')} onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatSearch, { detail: { chatId: dm.chatId, viewportKey: assistantSlotKey('task-chat') } }))}><Search /></IconButton>}
          </>} />
        {notice}{waitingOnDm?<div className="task-chat-notice" role="status">{t('tasks.chatUnavailable')}</div>:null}{dm.chatId
          ? <TaskChatScope chatId={dm.chatId}><ChatAreaPanel viewportKey={assistantSlotKey('task-chat')} activeTab="chats" mobile={mobile}
              chrome={{ placeholder: t('chat.placeholder', { name: agent.display_name }), attachGlyph: <Plus />, hideRunningStatus: true,runtimeReady }} {...handlers} /></TaskChatScope>
          : pendingContent??<div className="assistant-task-chat-window__pending">
              {dm.failed
                ? <><p>{t('chat.openFailed', { name: agent.display_name })}<br />{dm.failed.error}</p><Button onClick={dm.retry}>{t('machine.retry')}</Button></>
                : <LoadingIndicator size="panel" ariaLabel={t('chat.opening', { name: agent.display_name })} />}
            </div>}</TaskChatFilePreviewHost>
      </section>
  )
}
