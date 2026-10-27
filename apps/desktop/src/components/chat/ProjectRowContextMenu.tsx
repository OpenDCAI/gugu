import type { ReactNode } from 'react'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { useChatSummaries } from '../../lib/chatSummariesBridge'
import { requestShellChatAction } from '../../lib/sidebarChatsBridge'
import { chatsInReadScope, hasUnreadInRows } from '../../session/shared/conversation-row-menu'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'

/** Projects use the shell's existing chat projection/action channel across the two React roots. */
function ProjectRowMenuPopup({ chatId, onRemove, ...menu }: {
  x: number
  y: number
  chatId?: string
  onClose: () => void
  onRemove: () => void
}) {
  const summaries = useChatSummaries()
  const rows = [...summaries].map(([id, chat]) => ({ id, kind: chat.kind, source_chat_id: chat.sourceChatId,
    unread_count: chat.unreadCount, is_marked_unread: chat.isMarkedUnread }))
  const hasUnread = chatId !== undefined && summaries.has(chatId) && hasUnreadInRows(chatsInReadScope(rows, chatId))
  return <ConversationRowContextMenu {...menu} state={{ kind: 'project', hasUnread }} onAction={(action) => {
    if (action === 'mark-read' && chatId) requestShellChatAction({ kind: 'mark-read', chatId })
    else if (action === 'remove-project') onRemove()
  }} />
}

/** Keep stand-in devices and the assistant home under the original whole-menu restriction. */
export function ProjectRowContextMenu({ chatId, disabled, onRemove, children }: {
  chatId?: string
  disabled: boolean
  onRemove: () => void
  children: ReactNode
}) {
  const menu = useRowContextMenu()
  return <div onContextMenu={disabled ? undefined : menu.onContextMenu}>
    {children}
    {menu.menuPos && !disabled && <ProjectRowMenuPopup {...menu.menuPos} chatId={chatId} onClose={menu.closeMenu} onRemove={onRemove} />}
  </div>
}
