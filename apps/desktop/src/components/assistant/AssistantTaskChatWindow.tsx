import { useEffect } from 'react'
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
import './assistant-task-chat.css'

/** The task pane's own conversation, alongside the personal assistant. */
export function AssistantTaskChatWindow({ agent, onClose, ...handlers }: {
  agent: Pick<ContactUser, 'id' | 'display_name' | 'avatar'>
  onClose: () => void
} & AssistantChatHandlers) {
  const { t } = useTranslation('assistant')
  const mobile = useMobileShell()
  const dm = useAssistantDm(agent.id)
  useReportChatOnScreen(dm.chatId)
  useEffect(() => dm.chatId ? scheduleComposerFocus('chat-entry', { mobileShell: mobile }) : undefined, [dm.chatId, mobile])
  return (
      <section className="assistant-task-chat-window ta-skin" aria-label={agent.display_name} data-testid="assistant-task-chat-window">
        <PaneHeader title={agent.display_name} mobile={mobile} divider
          leading={<><IconButton aria-label={t('panel.back')} onClick={onClose} data-testid="assistant-task-chat-close"><ChevronLeft /></IconButton><Avatar name={agent.display_name} seed={agent.id} avatarUrl={agent.avatar} size="sm" isAgent still harnessBadge={false} /></>}
          actions={<>
            {dm.chatId && <IconButton aria-label={t('top.search')} onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatSearch, { detail: { chatId: dm.chatId, viewportKey: assistantSlotKey('task-chat') } }))}><Search /></IconButton>}
          </>} />
        {dm.chatId
          ? <TaskChatScope chatId={dm.chatId}><ChatAreaPanel viewportKey={assistantSlotKey('task-chat')} activeTab="chats" mobile={mobile}
              chrome={{ placeholder: t('chat.placeholder', { name: agent.display_name }), attachGlyph: <Plus />, hideRunningStatus: true }} {...handlers} /></TaskChatScope>
          : <div className="assistant-task-chat-window__pending">
              {dm.failed
                ? <><p>{t('chat.openFailed', { name: agent.display_name })}<br />{dm.error}</p><Button onClick={dm.retry}>{t('machine.retry')}</Button></>
                : <LoadingIndicator size="panel" ariaLabel={t('chat.opening', { name: agent.display_name })} />}
            </div>}
      </section>
  )
}
