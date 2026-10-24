import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import type { ChatPickRow } from './ChatPickSheet'

/** Compact, non-text-content preview label for the forwarded message. */
export function forwardPreview(
  message: Pick<MessageItem, 'content' | 'content_type'>,
  labels: { attachment: string; card: string; empty: string },
): string {
  if (message.content_type === 'attachment') return labels.attachment
  if (message.content_type === 'card') return labels.card
  const text = message.content?.trim()
  return text && text.length > 0 ? text : labels.empty
}

/** Chats that can receive a forward: not the source, and matching the query. */
export function forwardableChats(chats: ChatItem[], sourceChatId: string, query: string, displayName: (chat: ChatItem) => string): ChatItem[] {
  const q = query.trim().toLocaleLowerCase()
  return chats.filter((chat) => {
    if (chat.id === sourceChatId) return false
    if (!q) return true
    return displayName(chat).toLocaleLowerCase().includes(q)
  })
}

type Identities = Readonly<Record<string, { display_name: string; avatar: string | null; type?: string } | undefined>>

/** A chat as a row, by the name the caller gives it (its own for a group or topic, the peer's for a private chat). */
export function chatPickRow(chat: ChatItem, name: string, identitiesById: Identities): ChatPickRow {
  const identity = identitiesById[chat.peer_user_id ?? '']
  return {
    id: chat.id,
    name,
    // @@@2470 群没有 peer_user_id：不标 variant='group' 会被判成「缺身份 key 的人」，
    // 每次渲染刷一条诊断（agent e2e 的 console 守卫会当场失败）。口径同 ChatListPanel。
    avatar: {
      name,
      avatarUrl: isRoomChat(chat.kind) ? chat.avatar : identity?.avatar,
      seed: chat.peer_user_id ?? undefined,
      isAgent: identity?.type === 'agent',
      variant: isRoomChat(chat.kind) ? 'group' : 'default',
      memberAvatars: chat.member_user_ids?.flatMap((id) => {
        const member = identitiesById[id]
        return member ? [{ id, name: member.display_name, avatar: member.avatar }] : []
      }),
    },
  }
}
