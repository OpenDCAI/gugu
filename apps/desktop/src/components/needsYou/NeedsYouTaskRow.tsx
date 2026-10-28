import { Zap } from '@/lib/icons'
import { formatCalendarDay } from '@/lib/calendarTime'
import { useChatStore } from '@/store/chatContext'
import { Avatar } from '../Avatar'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { ListRow } from '../ui/ListRow'
import type { NeedsYouTask } from './useNeedsYouTasks'

/** Pending approvals retain their mobile row without restoring standalone tasks to Chats. */
export function NeedsYouTaskRow({ task, onClick, onKeyDown }: {
  task: NeedsYouTask
  onClick: React.MouseEventHandler<HTMLElement>
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
}) {
  const { identitiesById } = useChatStore('identitiesById')
  const { session } = task
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
    leading={<Avatar name={name} avatarUrl={agent?.avatar ?? null} seed={agentId} size="sm" isAgent />}
    title={name}
    accessory={<Zap size={11} className="shrink-0 text-[var(--agent-bolt)]" />}
    meta={Number.isFinite(time) ? formatCalendarDay(new Date(time).toISOString()) : undefined}
    subtitle={session.title}
    trailing={<AgentContactStatusMark tone="needs_user" />}
  />
}
