import { Bot } from '@/lib/icons'
import type { SidebarSessionLine } from '../lib/sidebarChatsBridge'
import { AgentContactStatusMark } from './AgentContactStatusMark'
import { ListRow } from './ui/ListRow'

// gugu-dev#181 没有项目的会话就是和它的 agent 私聊,和对话排在同一条「对话」列表里。行沿用会话行那一套:
// 名字 + 行尾的状态(要你处理 = 琥珀字形,在跑 = 点),和对话行尾的未读数落在同一个位置;没有头像 —— 它不是一个人或群。
const LEADING_STYLE: React.CSSProperties = { width: 40, display: 'flex', justifyContent: 'center', color: 'var(--text-tertiary)' }

export function SidebarSessionLineRow({ line, isActive, onClick }: {
  line: SidebarSessionLine
  isActive: boolean
  onClick: (event: React.MouseEvent) => void
}) {
  const tone = line.group === 'needs-you' ? 'needs_user' : line.group === 'working' ? 'working' : null
  return (
    <ListRow
      data-session-line={line.sessionId}
      selected={isActive}
      role="option"
      aria-selected={isActive}
      onClick={onClick}
      leading={<span style={LEADING_STYLE}><Bot size={18} /></span>}
      title={line.title}
      trailing={tone ? <AgentContactStatusMark tone={tone} /> : undefined}
    />
  )
}
