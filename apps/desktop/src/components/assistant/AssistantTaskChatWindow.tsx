import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Avatar } from '../Avatar'
import { PaneHeader } from '../ui/Pane'
import { IconButton } from '../ui/IconButton'
import { ChevronLeft } from '../../lib/icons'
import { LoadingIndicator } from '../../lib/loading/LoadingIndicator'
import { useMobileShell } from '../../hooks/useMobileShell'
import { useDevicesStore } from '../../store/devicesContext'
import type { TaskChatEndpoint } from '../../lib/assistantTaskChat'
import { PeekSessionTimeline } from '../../mobile/agent-watch/PeekSessionTimeline'
import { TaskChatFilePreviewHost } from './TaskChatFilePreviewHost'
import '@/mobile/agent-watch/agent-watch.css'
import '@/mobile/agent-watch/phone-conversation.css'
import './assistant-task-chat.css'

/** The task pane's own conversation, alongside the personal assistant: the task's session, as its task page shows it. */
export function AssistantTaskChatWindow({ agent, task, onClose, status, notice, pendingContent }: {
  agent: Pick<ContactUser, 'id' | 'display_name' | 'avatar'>
  task: TaskChatEndpoint
  onClose: () => void
  status?: string
  notice?: ReactNode
  pendingContent?: ReactNode
}) {
  const { t } = useTranslation('assistant')
  const mobile = useMobileShell()
  const { devices } = useDevicesStore()
  // The same test as the assistant's progress footnote (AssistantConversationProgress): this computer reads over IPC.
  const local = devices.some(device => device.device_id === task.deviceId && device.is_current_device)
  return (
    <section className="assistant-task-chat-window ta-skin" aria-label={agent.display_name} data-testid="assistant-task-chat-window">
      <TaskChatFilePreviewHost mobile={mobile}>
        <PeekSessionTimeline sessionId={task.sessionId} local={local} onBack={onClose} fallback={<>
          <PaneHeader title={agent.display_name} subtitle={status} mobile={mobile} divider
            leading={<><IconButton aria-label={t('panel.back')} onClick={onClose} data-testid="assistant-task-chat-close"><ChevronLeft /></IconButton><Avatar name={agent.display_name} seed={agent.id} avatarUrl={agent.avatar} size="sm" isAgent still harnessBadge={false} /></>} />
          {notice}
          {pendingContent ?? <div className="assistant-task-chat-window__pending"><LoadingIndicator size="panel" ariaLabel={t('chat.opening', { name: agent.display_name })} /></div>}
        </>} />
      </TaskChatFilePreviewHost>
    </section>
  )
}
