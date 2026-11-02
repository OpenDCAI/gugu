import { Zap } from '@/lib/icons'
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
export const NeedsYouTaskRow = observer(function NeedsYouTaskRow({ task, onClick, onKeyDown }: {
  task: NeedsYouTask
  onClick: React.MouseEventHandler<HTMLElement>
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
}) {
  const { identitiesById } = useChatStore('identitiesById')
  const { session } = task
  const presentation = sessionPresentation(session, true)
  const agentId = session.agent?.userId
  const agent = agentId ? identitiesById[agentId] : undefined
  const name = agent?.display_name || session.title
  const time = Date.parse(session.lastInteractedAt ?? '')
  return <ListRow
    data-session-line={session.conversationId}
    mobile
    tabIndex={0}
    role="option"
    aria-selected={false}
    onClick={onClick}
    onKeyDown={onKeyDown}
    leading={<PhoneMessageAvatar badge={presentation && <span className="inline-flex" role="img" aria-label={agentStatusText(presentation.label)}><AgentContactStatusMark tone={displayStatusOf(presentation.tone)} /></span>}>
      <Avatar name={name} avatarUrl={agent?.avatar ?? null} seed={agentId} size={48} isAgent harnessBadge={false} />
    </PhoneMessageAvatar>}
    title={name}
    accessory={<Zap size={11} className="shrink-0 text-[var(--agent-bolt)]" />}
    meta={Number.isFinite(time) ? formatCalendarDay(new Date(time).toISOString()) : undefined}
    subtitle={session.title}
  />
})
