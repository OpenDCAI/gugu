/** Row actions are shared by desktop context menus and future touch menus. */
export type ConversationRowAction = 'mark-read' | 'pin' | 'notifications' | 'mark-all-read' | 'delete-chat' | 'remove-project'
export type ConversationRowMenuState = {
  kind: 'chat' | 'project'
  hasUnread: boolean
  hasAnyUnread?: boolean
  pinned?: boolean
  notificationsMuted?: boolean
}

type RowMenuItem = {
  id: ConversationRowAction
  label: string
  icon: 'read' | 'pin' | 'notifications' | 'trash'
  disabled?: boolean
  danger?: boolean
}

export function conversationRowMenu(state: ConversationRowMenuState): RowMenuItem[] {
  const common: RowMenuItem[] = [{ id: 'mark-read', label: 'markRead', icon: 'read', disabled: !state.hasUnread }]
  return state.kind === 'project'
    ? [...common, { id: 'remove-project', label: 'removeProject', icon: 'trash', danger: true }]
    : [...common,
        { id: 'pin', label: state.pinned ? 'unpin' : 'pin', icon: 'pin' },
        { id: 'notifications', label: state.notificationsMuted ? 'enableNotifications' : 'disableNotifications', icon: 'notifications' },
        { id: 'mark-all-read', label: 'markAllRead', icon: 'read', disabled: !state.hasAnyUnread },
        { id: 'delete-chat', label: 'delete', icon: 'trash', danger: true },
      ]
}

type ChatScopeRow = { id: string; kind: string | null; source_chat_id?: string | null }

/** Include the selected conversation and its topic descendants, never its siblings or ancestors. */
export function chatsInReadScope<T extends ChatScopeRow>(chats: readonly T[], rootId: string): T[] {
  const children = new Map<string, T[]>()
  for (const chat of chats) {
    if (chat.kind !== 'topic' || !chat.source_chat_id) continue
    const siblings = children.get(chat.source_chat_id) ?? []
    siblings.push(chat)
    children.set(chat.source_chat_id, siblings)
  }
  const ids = new Set([rootId])
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child.id)
  return chats.filter((chat) => ids.has(chat.id))
}

export function hasUnreadInRows(rows: readonly { unread_count: number; is_marked_unread?: boolean }[]): boolean {
  return rows.some((row) => row.unread_count > 0 || row.is_marked_unread === true)
}
