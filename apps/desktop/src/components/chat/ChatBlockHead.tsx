import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import type { ChatContextValue } from '../../store/chatContext'
import { Avatar } from '../Avatar'
import { identityDisplayName } from '../../lib/displayIdentity'

/**
 * gugu-dev#181 聊天画在会话页一块里(项目块的项目群、对话块,见 ChatSlotHost)时的头:块顶上那条页签条就是头,
 * 头栏右边那排图标画进块顶的 `actions` 那一格,对话的头像和名字画进第一枚页签(`title`)。格子还没挂上 = 不画。
 */
export function ChatBlockHead({ host, actions, chat, name, avatar, isAgent, identitiesById }: {
  host: { actions: HTMLElement | null; title: HTMLElement | null }
  actions: ReactNode
  chat: ChatItem
  name: string
  avatar: string | null
  isAgent: boolean
  identitiesById: ChatContextValue['identitiesById']
}) {
  const room = isRoomChat(chat.kind)
  const members = chat.member_user_ids?.flatMap((id) => identitiesById[id] ? [identitiesById[id]] : []) ?? []
  return (
    <>
      {host.actions ? createPortal(actions, host.actions) : null}
      {host.title ? createPortal(
        <span className="flex min-w-0 items-center gap-1" data-chat-block-title="">
          <Avatar
            name={name}
            avatarUrl={avatar}
            seed={chat.peer_user_id ?? undefined}
            isAgent={isAgent}
            variant={room ? 'group' : 'default'}
            memberAvatars={room ? members.map((identity) => ({ id: identity.id, name: identityDisplayName(identity, members), avatar: identity.avatar })) : undefined}
            size={16}
            still
          />
          <span className="min-w-0 truncate">{name}</span>
        </span>,
        host.title,
      ) : null}
    </>
  )
}
