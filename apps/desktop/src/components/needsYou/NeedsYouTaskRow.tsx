import { useShownAgentName } from '@/hooks/useShownAgentName'
import { formatCalendarDay } from '@/i18n/format'
import { useChatStore } from '@/store/chatContext'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { agentStatusText } from '@/lib/agentStatusText'
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { observer } from 'mobx-react-lite'
import { Avatar } from '../Avatar'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { ListRow } from '../ui/ListRow'
import { PhoneMessageAvatar } from '@/mobile/chat/PhoneMessageAvatar'
import type { NeedsYouTask } from './useNeedsYouTasks'

/** Attention tasks retain their canonical status without restoring standalone tasks to Chats. */
export const NeedsYouTaskRow = observer(function NeedsYouTaskRow({ task, onClick, onKeyDown, mobile = true, emphasis }: {
  task: NeedsYouTask
  mobile?: boolean
  /** Unread (still counted), as chat rows mark unread messages. */
  emphasis?: boolean
  onClick: React.MouseEventHandler<HTMLElement>
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
}) {
  const { identitiesById } = useChatStore('identitiesById')
  const { session } = task
  const presentation = sessionPresentation(session, true)
  const agentId = session.agent?.userId
  const agent = agentId ? identitiesById[agentId] : undefined
  const [name, title] = useShownAgentName([
    { name: agent?.display_name || session.title, createdAt: agent?.created_at ?? undefined },
    { name: session.title, createdAt: agent?.created_at ?? undefined },
  ])
  const time = Date.parse(session.lastInteractedAt ?? '')
  return <ListRow
    data-session-line={session.conversationId}
    mobile={mobile}
    tabIndex={0}
    role="option"
    aria-selected={false}
    emphasis={emphasis}
    onClick={onClick}
    onKeyDown={onKeyDown}
    leading={<PhoneMessageAvatar badge={presentation && <span className="inline-flex" role="img" aria-label={agentStatusText(presentation.label)}><AgentContactStatusMark tone={displayStatusOf(presentation.tone)} /></span>}>
      <Avatar name={name!} avatarUrl={agent?.avatar ?? null} seed={agentId} size={mobile ? 48 : 'sm'} isAgent harnessBadge={false} />
    </PhoneMessageAvatar>}
    title={name}
    meta={Number.isFinite(time) ? formatCalendarDay(new Date(time).toISOString()) : undefined}
    subtitle={title}
  />
})
