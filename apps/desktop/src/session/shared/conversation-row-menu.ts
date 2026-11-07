/** Row actions are shared by desktop context menus and future touch menus. */
export type ConversationRowAction = 'mark-read' | 'pin' | 'notifications' | 'mark-all-read' | 'delete-chat' | 'remove-project'
/** Personal DM deletion requires an archived/removed owned Agent, matching delete_my_dm_conversation. */
export function conversationCanDelete(kind: string | null, authority?: { can_dissolve?: boolean; can_archive_topic?: boolean } | null, ownedAgentDm?: { session_archived_at?: string | null; removed_at?: string | null }): boolean {
  return (kind === 'dm' && !!ownedAgentDm && (ownedAgentDm.session_archived_at != null || ownedAgentDm.removed_at != null)) || (kind === 'group' && authority?.can_dissolve === true) || (kind === 'topic' && authority?.can_archive_topic === true)
}
export type ConversationRowMenuState = ({ kind: 'chat'; canDelete: boolean } | { kind: 'project' } | { kind: 'topic' }) & {
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
  /** 收进「更多」:影响整张列表或不可撤回的,不是这一行的日常动作。 */
  fold?: true
}

export function conversationRowMenu(state: ConversationRowMenuState): RowMenuItem[] {
  const common: RowMenuItem[] = [{ id: 'mark-read', label: 'markRead', icon: 'read', disabled: !state.hasUnread }]
  if (state.kind === 'topic') return [...common, { id: 'mark-all-read', label: 'markAllRead', icon: 'read', disabled: !state.hasAnyUnread }]
  return state.kind === 'project'
    ? [...common, { id: 'remove-project', label: 'removeProject', icon: 'trash', danger: true }]
    : [...common,
        { id: 'pin', label: state.pinned ? 'unpin' : 'pin', icon: 'pin' },
        { id: 'notifications', label: state.notificationsMuted ? 'enableNotifications' : 'disableNotifications', icon: 'notifications' },
        { id: 'mark-all-read', label: 'markAllRead', icon: 'read', disabled: !state.hasAnyUnread, fold: true },
        ...(state.canDelete ? [{ id: 'delete-chat', label: 'delete', icon: 'trash', danger: true, fold: true } as const] : []),
      ]
}

type ChatScopeRow = { id: string; kind: string | null; source_chat_id?: string | null }

/** Include the selected conversations and their topic descendants, never their siblings or ancestors. */
export function chatsInReadScope<T extends ChatScopeRow>(chats: readonly T[], rootId: string | readonly string[]): T[] {
  const children = new Map<string, T[]>()
  for (const chat of chats) {
    if (chat.kind !== 'topic' || !chat.source_chat_id) continue
    const siblings = children.get(chat.source_chat_id) ?? []
    siblings.push(chat)
    children.set(chat.source_chat_id, siblings)
  }
  const ids = new Set(typeof rootId === 'string' ? [rootId] : rootId)
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child.id)
  return chats.filter((chat) => ids.has(chat.id))
}

export function hasUnreadInRows(rows: readonly { unread_count: number; is_marked_unread?: boolean }[]): boolean {
  return rows.some((row) => row.unread_count > 0 || row.is_marked_unread === true)
}
