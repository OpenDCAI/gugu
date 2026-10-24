import { Zap } from '@/lib/icons'
import { formatCalendarDay } from '../lib/calendarTime'
import type { SidebarSessionLine } from '../lib/sidebarChatsBridge'
import { useChatStore } from '../store/chatContext'
import { AgentContactStatusMark } from './AgentContactStatusMark'
import { Avatar } from './Avatar'
import { ListRow } from './ui/ListRow'
import { clearDraggedSession, setDraggedSession } from '../session/renderer/lib/drag-session'

// gugu-dev#181 没有项目的会话就是和它的 agent 私聊,和对话排在同一条「对话」列表里,照私聊那一行画:agent 的头像和名字、
// 第二行是这个会话的标题、右上是最后活动的时刻;行尾是状态(要你处理 = 琥珀字形,在跑 = 点),和对话行尾的未读数落在同一个位置。
export function SidebarSessionLineRow({ line, isActive, onClick }: {
  line: SidebarSessionLine
  isActive: boolean
  onClick: (event: React.MouseEvent) => void
}) {
  const { identitiesById } = useChatStore('identitiesById')
  const agent = line.agentUserId ? identitiesById[line.agentUserId] : undefined
  const name = agent?.display_name || line.title
  const tone = line.group === 'needs-you' ? 'needs_user' : line.group === 'working' ? 'working' : null
  return (
    <ListRow
      data-session-line={line.sessionId}
      draggable
      onDragStart={(event) => setDraggedSession(event.dataTransfer, { sessionId: line.sessionId, title: line.title, projectId: line.projectId }, event.currentTarget)}
      onDragEnd={clearDraggedSession}
      selected={isActive}
      role="option"
      aria-selected={isActive}
      onClick={onClick}
      leading={<Avatar name={name} avatarUrl={agent?.avatar ?? null} seed={line.agentUserId ?? undefined} size="sm" isAgent />}
      title={name}
      accessory={<Zap size={11} className="shrink-0 text-[var(--agent-bolt)]" />}
      meta={formatCalendarDay(new Date(line.time).toISOString())}
      subtitle={line.title}
      trailing={tone ? <AgentContactStatusMark tone={tone} /> : undefined}
    />
  )
}
